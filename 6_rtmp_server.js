// 官方文档: https://raw.githubusercontent.com/runner365/read_book/master/rtmp/rtmp_specification_1.0.pdf
// 翻译文档: https://github.com/runner365/read_book/blob/master/rtmp/rtmp_specification_1.0_%E8%87%AA%E8%AF%91.md

const Net = require("net");

const port = 1935;

const server = Net.createServer((socket) => {
  console.log("client connected", socket);
});

server.listen(port, () => {
  console.log(`start on 1935`);
});

server.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

server.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});
