#!/usr/bin/env python3
"""
ZoeWeb SPP bridge — makes a CLASSIC Bluetooth (SPP) ELM327 usable from the browser.

Browsers cannot talk to classic Bluetooth serial devices, so this script connects
to the dongle over RFCOMM (no extra Python packages needed on Linux) and exposes
it as a WebSocket on localhost. In ZoeWeb, pick "Classic Bluetooth via PC bridge"
and connect.

NOTE for macOS: you usually do NOT need this script. Pair the dongle in
System Settings > Bluetooth (PIN 1234 or 0000) and macOS creates a virtual
serial port /dev/cu.<name> — pick it directly in ZoeWeb via "USB / serial
ELM327 (Web Serial)". Use this bridge only if that fails.

Usage (Linux, RFCOMM):   python3 tools/spp-bridge.py AA:BB:CC:DD:EE:FF
Usage (macOS, serial):   python3 tools/spp-bridge.py /dev/cu.OBDII
Then in ZoeWeb settings, choose the bridge transport and press Connect.

Options:
  --channel N   RFCOMM channel (default 1)
  --port N      WebSocket port (default 8472)
  --bind ADDR   bind address (default 127.0.0.1; use 0.0.0.0 to reach it from a
                phone on your LAN — the page must then be http://<pc-ip>, not https)
  --loopback    no Bluetooth: fake ELM327 answering OK to everything (self-test)
"""
import argparse
import base64
import hashlib
import socket
import sys
import threading

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def open_serial(path):
    import termios
    import tty
    fd = None
    try:
        import os
        fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
        tty.setraw(fd)
        attrs = termios.tcgetattr(fd)
        attrs[4] = attrs[5] = termios.B38400  # baud is virtual for BT serial
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except OSError as e:
        sys.exit(f'[serial] cannot open {path}: {e}')

    class SerialSock:
        def send(self, data):
            os.write(fd, data)
        def recv(self, n):
            return os.read(fd, n)
        def close(self):
            os.close(fd)
    print(f'[serial] opened {path}')
    return SerialSock()


def open_bluetooth(mac, channel):
    try:
        sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        sock.connect((mac, channel))
        print(f'[bt] connected to {mac} channel {channel}')
        return sock
    except AttributeError:
        sys.exit('This Python build lacks AF_BLUETOOTH (Linux required).')
    except OSError as e:
        sys.exit(f'[bt] cannot connect to {mac}: {e}\n'
                 '     Is the dongle paired (bluetoothctl) and plugged into the car?')


class FakeElm:
    """--loopback: pretends to be an ELM327 so the whole path can be tested."""
    def __init__(self):
        self._rx = b''
        self._event = threading.Event()

    def send(self, data):
        for line in data.replace(b'\n', b'\r').split(b'\r'):
            if not line:
                continue
            cmd = line.strip().lower()
            if cmd in (b'atz', b'atws', b'atd'):
                self._push(b'ELM327 v1.5 (bridge loopback)\r>')
            elif cmd.startswith(b'at'):
                self._push(b'OK\r>')
            else:
                self._push(b'NO DATA\r>')

    def _push(self, data):
        self._rx += data
        self._event.set()

    def recv(self, _n):
        self._event.wait()
        self._event.clear()
        data, self._rx = self._rx, b''
        return data

    def close(self):
        pass


def ws_accept_key(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def ws_send(conn, payload, lock, opcode=2):
    header = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + n.to_bytes(2, 'big')
    else:
        header += bytes([127]) + n.to_bytes(8, 'big')
    with lock:
        conn.sendall(header + payload)


def ws_recv_frame(conn):
    def read_exact(n):
        buf = b''
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('client gone')
            buf += chunk
        return buf

    b1, b2 = read_exact(2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = int.from_bytes(read_exact(2), 'big')
    elif length == 127:
        length = int.from_bytes(read_exact(8), 'big')
    mask = read_exact(4) if masked else b'\x00' * 4
    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(read_exact(length)))
    return opcode, payload


def handle_client(conn, bt, lock):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return
        data += chunk
    headers = {}
    for line in data.decode(errors='replace').split('\r\n')[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    key = headers.get('sec-websocket-key')
    if not key:
        conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'
                     b'ZoeWeb SPP bridge is running. Connect from the app via WebSocket.\n')
        return
    conn.sendall((
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {ws_accept_key(key)}\r\n\r\n').encode())
    print('[ws] client connected')

    stop = threading.Event()

    def bt_to_ws():
        try:
            while not stop.is_set():
                chunk = bt.recv(4096)
                if not chunk:
                    break
                ws_send(conn, chunk, lock)
        except OSError:
            pass
        stop.set()

    t = threading.Thread(target=bt_to_ws, daemon=True)
    t.start()
    try:
        while not stop.is_set():
            opcode, payload = ws_recv_frame(conn)
            if opcode == 8:          # close
                break
            if opcode == 9:          # ping → pong
                ws_send(conn, payload, lock, opcode=10)
                continue
            if payload:
                bt.send(payload)
    except (ConnectionError, OSError):
        pass
    stop.set()
    print('[ws] client disconnected')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mac', nargs='?', help='dongle MAC (Linux) or serial device path like /dev/cu.OBDII (macOS)')
    ap.add_argument('--channel', type=int, default=1)
    ap.add_argument('--port', type=int, default=8472)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--loopback', action='store_true', help='fake ELM327, no Bluetooth (self-test)')
    args = ap.parse_args()

    if args.loopback:
        bt = FakeElm()
        print('[bt] loopback mode — fake ELM327')
    elif args.mac and args.mac.startswith('/'):
        bt = open_serial(args.mac)
    elif args.mac:
        bt = open_bluetooth(args.mac.upper(), args.channel)
    else:
        ap.error('give the dongle MAC address or serial device path (or --loopback)')

    lock = threading.Lock()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.bind, args.port))
    srv.listen(1)
    print(f'[ws] listening on ws://{args.bind}:{args.port} — in ZoeWeb pick '
          '"Classic Bluetooth via PC bridge" and Connect (Ctrl+C to quit)')
    try:
        while True:
            conn, _addr = srv.accept()
            try:
                handle_client(conn, bt, lock)
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
    except KeyboardInterrupt:
        print('\nbye')
    finally:
        bt.close()


if __name__ == '__main__':
    main()
