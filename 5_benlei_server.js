const Net = require("net");

const port = 1234;
const socketMap = {};

const tcpServer = Net.createServer((socket) => {
  socket.on("data", (data) => {
    const reqData = data.toString().split("\r\n");
    console.log("请求:", reqData);

    // 截取请求体
    const [head, ...body] = reqData;
    const [protocol, type] = head.split(" ");

    console.log(head, type, body);

    // 处理非benlei协议的
    if (protocol.indexOf("BENLEI/1.0") < 0) {
      socket.write(`BENLEI/1.0 FAIL\n\nfuck off\n`);
      socket.end();
      return;
    }

    // 处理类型
    switch (type) {
      // ping一下
      case "PING": {
        socket.write(`BENLEI/1.0 SUCCESS\n\nHi iam Benlei\n`);
        socket.end();
        break;
      }
      // 加入
      case "JOIN": {
        const socketId = Date.now();
        socketMap[socketId] = socket;
        socket.write(`BENLEI/1.0 SUCCESS\n\njoin success\n`);
        // console.log(socketMap);
        break;
      }
      // 广播
      case "BOARDCAST": {
        for (let s of Object.values(socketMap)) {
          s.write(`BENLEI/1.0 SUCCESS\n\n${body[0]}\n`);
        }
        socket.write(`BENLEI/1.0 SUCCESS\n\nboardcast success\n`);
        break;
      }
      default: {
        socket.write(`BENLEI/1.0 SUCCESS\n\nThis Is Benlei Protocol\n`);
        socket.end();
      }
    }
  });
});

tcpServer.listen(port, () => {
  console.log(`server start on localhost:${1234}, 5_run.sh | telnet`);
});
