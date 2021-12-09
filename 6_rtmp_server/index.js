const Logger = require("./Logger");
const Net = require("net");

const port = 1935;

// 创建个server
const server = Net.createServer((socket) => {
  const session = new Session(socket);
  session.run();
});

// 处理每个socket session
class Session {
  constructor(socket) {
    this.socket = socket;
    this.handshakeState = 0; // 握手状态
  }

  // 绑定一下事件
  run() {
    this.socket.on("data", this.onData.bind(this));
  }

  // 处理data
  onData(data) {
    Logger("ondata:", "data-length:", data.length, "handshakeState:", this.handshakeState);
    console.log("data:", data);

    // 根据握手状态处理
    // 按道理要c012s012共5个状态,酌情写浓缩一下
    switch (this.handshakeState) {
      // Uninitialized
      // c0c1(1+1536) -> s0s1s2(1+1536+1536)
      case 0: {
        this.handshakeState = 3;
        const s0s1s2 = this.generateS0S1S2(data);
        this.socket.write(s0s1s2);
        break;
      }
      // Connected
      // read chunk
      case 3:
      default: {
        this.rtmpChunkRead(data);
      }
    }
  }

  generateS0S1S2(data) {
    const version = Buffer.from(data[0].toString());
    const clientSign = Buffer.alloc(1536, 0);
    data.copy(clientSign, 0, 1, 1537);
    const serverSign = Buffer.alloc(1536, 0);
    const s0s1s2 = Buffer.concat([version, serverSign, clientSign]);
    return s0s1s2;
  }

  rtmpChunkRead(data) {}
}

// 启动服务监听一下端口
server.listen(port, () => {
  console.log(`start on rtmp://localhost`);
  console.log(`run 'ffmpeg -re -i ~/Downloads/bangbang.mp4 -f flv rtmp://127.0.0.1'`);
});

server.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

server.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});