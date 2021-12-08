// 官方文档: https://raw.githubusercontent.com/runner365/read_book/master/rtmp/rtmp_specification_1.0.pdf
// 翻译文档: https://github.com/runner365/read_book/blob/master/rtmp/rtmp_specification_1.0_%E8%87%AA%E8%AF%91.md

const Logger = require("./Logger");
const Net = require("net");
const Handshake = require("./node_rtmp_handshake");

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
    this.handshakeState = 0;
    this.handshakeBytes = 0;
    this.handshakePayload = Buffer.alloc(1536);
  }

  // 绑定一下事件
  run() {
    this.socket.on("data", this.onData.bind(this));
  }

  // 处理data
  onData(data) {
    Logger("data come", data.length);
    let bytes = data.length;
    let p = 0;
    let n = 0;
    while (bytes > 0) {
      Logger("handshakeState", this.handshakeState, p, n);
      switch (this.handshakeState) {
        // c0
        case 0: {
          this.handshakeState = 1;
          this.handshakeBytes = 0;
          bytes -= 1;
          p += 1;
          break;
        }
        // c1
        case 1: {
          n = 1536 - this.handshakeBytes;
          n = n <= bytes ? n : bytes;
          data.copy(this.handshakePayload, this.handshakeBytes, p, p + n);
          this.handshakeBytes += n;
          bytes -= n;
          p += n;
          if (this.handshakeBytes === 1536) {
            this.handshakeState = 2;
            this.handshakeBytes = 0;
            let s0s1s2 = Handshake.generateS0S1S2(this.handshakePayload);
            this.socket.write(s0s1s2);
          }
          break;
        }
        // c2
        case 2: {
          n = 1536 - this.handshakeBytes;
          n = n <= bytes ? n : bytes;
          data.copy(this.handshakePayload, this.handshakeBytes, p, n);
          this.handshakeBytes += n;
          bytes -= n;
          p += n;
          if (this.handshakeBytes === 1536) {
            this.handshakeState = 3;
            this.handshakeBytes = 0;
            this.handshakePayload = null;
          }
          break;
        }
        // chunk
        case 3:
        default: {
          this.socket.end();
        }
      }
    }
  }

  rtmpChunkRead(data, p, bytes) {}
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
