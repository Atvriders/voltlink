// Minimal SMTP sink for e2e: accepts any message and drops it. Enough for
// nodemailer to complete sendMail against 127.0.0.1:1025.
import net from 'node:net';

const server = net.createServer((socket) => {
  socket.write('220 voltlink-e2e ESMTP\r\n');
  let inData = false;
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\r\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (inData) {
        if (line === '.') {
          inData = false;
          socket.write('250 OK: queued\r\n');
        }
        continue;
      }
      const verb = line.split(' ')[0]?.toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') socket.write('250-voltlink-e2e\r\n250 OK\r\n');
      else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 OK\r\n');
      else if (verb === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (verb === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
      } else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 OK\r\n');
      else socket.write('250 OK\r\n');
    }
  });
});

server.listen(1025, '127.0.0.1', () => {
  console.log('fake smtp listening on 127.0.0.1:1025');
});
