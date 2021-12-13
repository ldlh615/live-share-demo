// Message > Chunk

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
    /* ----- 开始握手 ----- 
    RTMP协议的实现者需要保证这几点：
    - 客户端要等收到S1之后才能发送C2
    - 客户端要等收到S2之后才能发送其他信息（控制信息和真实音视频等数据）
    - 服务端要等到收到C0之后发送S1
    - 服务端必须等到收到C1之后才能发送S2
    - 服务端必须等到收到C2之后才能发送其他信息（控制信息和真实音视频等数据）

    理论上来讲只要满足以上条件，如何安排6个Message的顺序都是可以的，但实际实现中为了在保证握手的身份验证功能的基础上尽量减少通信的次数，一般的发送顺序是这样的
    ｜client｜Server ｜
    ｜－－－C0+C1—->|
    ｜<－－S0+S1+S2– |
    ｜－－－C2-－－－> ｜
    */
    switch (this.handshakeState) {
      // Uninitialized
      // c0c1(1+1536) -> s0s1s2(1+1536+1536)
      case 0: {
        this.handshakeState = 3;
        const s0s1s2 = this.generateS0S1S2(data);
        this.socket.write(s0s1s2);
        break;
      }
      // c2
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

  /* ----- 开始解析块(Chunk) ----- 
  # 发送端把RTMP Message划分为一个个Chunk，意味着Chunk就是传输过程数据的最小单位。
    所以，解析RTMP Message，就是解析Chunk

  # 下面给出了块(Chunk)的标准格式, 一个块(chunk)是由块头(Chunk Header)和块数据(Chunk Data)组成的
  +--------------+----------------+--------------------+---------------------------------------+
  | Basic Header | Message Header | Extended Timestamp |                Chunk Data             |
  +--------------+----------------+--------------------+---------------------------------------+
  |<------------------- Chunk Header ----------------->|


  Basic Header 由chunk type和chunk stream id组成
  0 1 2 3 4 5 6 7 
  +-+-+-+-+-+-+-+-+ 
  |fmt|   cs id   | 
  +-+-+-+-+-+-+-+-+
  Chunk basic header 1


  */
  rtmpChunkRead(data) {
    const basicHeader = data[0];
    const basicHeaderFmt = basicHeader[0];
    const basicHeaderStreamID = basicHeader[0];

    console.log(data);
    console.log(basicHeader);
    console.log(basicHeaderFmt);
    console.log(basicHeaderStreamID);
  }
}

// 启动服务监听一下端口
server.listen(port, () => {
  console.log(`start on rtmp://localhost`);
  console.log(`run 'ffmpeg -re -i ~/Downloads/bangbang.mp4 -f flv rtmp://127.0.0.1/live/aaa'`);
});

server.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

server.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});

const buf1 = Buffer.from("1234567890");
console.log(buf1);
console.log(buf1.byteLength);
