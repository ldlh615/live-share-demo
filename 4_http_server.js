const Net = require("net");

const port = 1234;

const tcpServer = Net.createServer((socket) => {
  socket.on("data", (data) => {
    console.log(data.toString());
    socket.write("HTTP/1.1 200 OK\n\nhello world");
    socket.end((err) => {
      console.log(err);
    });
  });
});

tcpServer.listen(port, () => {
  console.log(`server start on localhost:${1234}, http://localhost:1234`);
});
