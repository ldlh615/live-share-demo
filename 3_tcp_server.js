const Net = require("net");

const port = 1234;

const tcpServer = Net.createServer((socket) => {
  console.log("client connected");
  socket.write("hello word\n");
  socket.end();
});

tcpServer.listen(port, () => {
  console.log(`server start on localhost:${1234}, telnet localhost 1234`);
});

tcpServer.on("connection", (e) => {
  console.log('connection open');
});

tcpServer.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

tcpServer.on("close", () => {
  console.log("server close");
});