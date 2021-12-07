const Net = require("net");

const port = 1234;

const tcpServer = Net.createServer((socket) => {
  socket.on("data", (data) => {
    const reqData = data.toString().split("\r\n");
    console.log("请求:", reqData);

    // 截取请求体
    const [head, ...body] = reqData;

    console.log(head, body);

    // 处理非benlei协议的
    if (!head || head.indexOf("BENLEI/1.0") < 0) {
      socket.write(`BENLEI/1.0 fail\nfuck off`);
      socket.end();
      return;
    }

    // ... do something u like ...

    socket.write(`BENLEI/1.0 ok\n\nhi iam Benlei`);
    socket.end();
  });
});

tcpServer.listen(port, () => {
  console.log(`server start on localhost:${1234}, 5_run.sh | telnet`);
});
