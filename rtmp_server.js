const Net = require("net");

const tcpServer = Net.createServer((socket) => {
  console.log("client connected", socket);
});

tcpServer.listen(1935, () => {
  console.log(`start on 1935`);
});

tcpServer.on("connection", (e) => {
  console.log(e);
});

tcpServer.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

tcpServer.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});
