// SMTP sink for e2e that also exposes received messages over HTTP, so the
// Playwright helpers can read the real verification email in production mode
// (R2-24: DEV_ECHO_TOKENS is refused outside development).
import net from 'node:net';
import http from 'node:http';

// R2-24: ports come from the environment (start-stack.sh sets them) so two
// stacks on one shared machine never fight over 1025/1026.
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const HTTP_PORT = Number(process.env.VL_SMTP_HTTP_PORT ?? 1026);
const HOST = process.env.HOST ?? '127.0.0.1';

const messages = []; // { to, text, textDecoded }

// Minimal quoted-printable decoder (the node stdlib has none): un-fold soft
// line breaks and resolve =XX escapes.
const qpDecode = (s) =>
  s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const smtp = net.createServer((socket) => {
  socket.on('error', () => {});
  const safe = (text) => {
    try {
      socket.write(text);
    } catch {
      /* client gone */
    }
  };
  safe('220 voltlink-e2e ESMTP\r\n');
  let inData = false;
  let buf = '';
  let rcptTo = '';
  let dataBuf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\r\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push({ to: rcptTo, text: dataBuf, textDecoded: qpDecode(dataBuf) });
          dataBuf = '';
          safe('250 OK: queued\r\n');
        } else {
          dataBuf += line + '\n';
        }
        continue;
      }
      const verb = line.split(' ')[0]?.toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') safe('250-voltlink-e2e\r\n250 OK\r\n');
      else if (verb === 'MAIL') safe('250 OK\r\n');
      else if (verb === 'RCPT') {
        rcptTo = line.replace(/^RCPT TO:</i, '').replace(/>.*$/, '');
        safe('250 OK\r\n');
      } else if (verb === 'DATA') {
        inData = true;
        dataBuf = '';
        safe('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (verb === 'QUIT') {
        safe('221 Bye\r\n');
        socket.end();
      } else if (verb === 'RSET' || verb === 'NOOP') safe('250 OK\r\n');
      else safe('250 OK\r\n');
    }
  });
});
smtp.listen(SMTP_PORT, HOST, () => console.log(`fake smtp listening on ${HOST}:${SMTP_PORT}`));

http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url === '/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages }));
      return;
    }
    // /last?to=<address> returns the most recent message for that recipient.
    if (req.url.startsWith('/last')) {
      const u = new URL(req.url, 'http://127.0.0.1');
      const to = u.searchParams.get('to') ?? '';
      const found = [...messages].reverse().find((m) => !to || m.to === to);
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(found ? JSON.stringify(found) : '{"error":"no message"}');
      return;
    }
    res.writeHead(404).end();
  })
  .listen(HTTP_PORT, HOST, () => console.log(`fake smtp http on ${HOST}:${HTTP_PORT}`));
