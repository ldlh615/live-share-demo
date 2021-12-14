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
    console.log("ondata", data.length);
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
        this.handshakeState = 2;
        const s0s1s2 = this.generateS0S1S2(data);
        this.socket.write(s0s1s2);
        break;
      }
      // c2
      case 2: {
        this.handshakeState = 3;
        if (data.length === 1536) {
          break;
        }
        const length = data.length > 1536 ? data.length - 1536 : data.length;
        const offset = data.length > 1536 ? 1536 : 0;
        const cData = Buffer.alloc(length, 0);
        data.copy(cData, 0, offset);
        this.rtmpChunkRead(cData);
        break;
      }
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
  发送端把RTMP Message划分为一个个Chunk，意味着Chunk就是传输过程数据的最小单位。
    所以，解析RTMP Message，就是解析Chunk

    还有个注意点是大端排序

  下面给出了块(Chunk)的标准格式, 一个块(chunk)是由块头(Chunk Header)和块数据(Chunk Data)组成的
  +--------------+----------------+--------------------+---------------------------------------+
  | Basic Header | Message Header | Extended Timestamp |                Chunk Data             |
  +--------------+----------------+--------------------+---------------------------------------+
  |<------------------- Chunk Header ----------------->|
  */
  rtmpChunkRead(data) {
    console.log("chunkread", data.length, data[0].toString(2), data[0] & 0x3f);

    /* ----- 解析 Basic Header -----
    Basic Header 由chunk type和chunk stream id组成, 也就是fmt(块类型)和csid(块id)
    Basic Header字段长度可以是1，2或3字节
    整体长度由

    0 1 2 3 4 5 6 7 
    +-+-+-+-+-+-+-+-+ 
    |fmt|   cs id   | 
    +-+-+-+-+-+-+-+-+
    Chunk basic header 1

    chunk stream id值范围64-319是其头中的两个字节。ID为第二个字节+64。
    0               1
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |fmt|     0     |   cs id - 64  | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    Chunk basic header 2

    chunk streamid 54-65599范围在3个字节的版本中编码。ID等于：第三个字节*256+第二个字节+64。
    0               1               2
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |fmt|     1     |         cs id - 64            | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    Chunk basic header 3
    */
    const chunkBasicHeader = data[0]; // 一个字节=8bit = 上面的任意一种
    const formatType = chunkBasicHeader[0] >> 6; // 右位移6位取前2位
    let chunkStreamID = chunkBasicHeader[0] & 0x3f; // 0x3f=0b111111,且操作,取后六位
    let parserBytes = 1; // 预设值,因为还有可能是3字节
    // 根据上面header结构,重新新取值
    switch (chunkStreamID) {
      // 0b000000 & 0b111111 = 0, 所以是情况2: Basic Header占用2个字节，CSID在［64，319］之间
      case 0: {
        chunkStreamID = data[1] + 64;
        parserBytes = 2;
        break;
      }
      // 0b000001 & 0b111111 = 1, 所以是情况3: Basic Header占用3个字节，CSID在［64，65599］之间
      case 1: {
        chunkStreamID = (data[1] << 8) + data[2] + 64;
        parserBytes = 3;
        break;
      }
      // 剩下就是情况1, 该chunk是控制信息和一些命令信息
      // case 2: {
      //   break;
      // }
    }

    /* ----- 解析Message Header -----
    格式和长度取决于Basic Header的chunk type，共有4种不同的格式

    Type 0 chunk header是11字节长。这个type 0类型必须是在chunk stream的最开始使用，并且无论什么时候stream timestamp都应该是向后发展的
    0                    1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                timestamp                      |message length | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |     message length (cont)     |message type id| msg stream id | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |             message stream id (cont)          | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    Chunk Message Header - Type 0
    timestamp (3 bytes): 对于type-0的chunk，消息使用绝对时间戳。
    如果时间戳大于等于16777215 (16进制0xFFFFFF)，这个字段必须是16777215，意味着Extended Timestamp字段32bit的时间戳。


    */
    switch (formatType) {
      case 0: {
        break;
      }
      case 1: {
        break;
      }
      case 2: {
        break;
      }
      case 3: {
        break;
      }
    }

    console.log(formatType, chunkStreamID);

    this.socket.end();
  }

  createRtmpMessage() {}

  handleRtmpMessage() {}

  handleAMFDataMessage() {}

  handleAMFCommandMessage() {}

  windowACK(size) {
    const rtmpBuffer = Buffer.from("02000000000004050000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('windowACK: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  }

  setPeerBandwidth(size, type) {
    const rtmpBuffer = Buffer.from("0200000000000506000000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    rtmpBuffer[16] = type;
    // //console.log('setPeerBandwidth: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  }

  setChunkSize(size) {
    const rtmpBuffer = Buffer.from("02000000000004010000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('setChunkSize: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  }

  sendStreamEOF() {
    const rtmpBuffer = Buffer.from("020000000000060400000000000100000001", "hex");
    this.socket.write(rtmpBuffer);
  }
}

// 启动服务监听一下端口
server.listen(port, () => {
  // console.clear();
  console.log(`start on rtmp://localhost`);
  console.log(`run 'ffmpeg -re -i ~/Downloads/bangbang.mp4 -f flv rtmp://127.0.0.1/live/aaa'`);
  console.log("---------------------------------------------");
});

server.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

server.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});

const b = Buffer.from([0x01, 0x02]);
console.log(b[0] * 256 + b[1]);
console.log((b[0] << 8) + b[1]);
