const AMF = require("./node_core_amf");
const Logger = require("./Logger");
const Net = require("net");

const port = 1935;
const rtmpHeaderSize = [11, 7, 3, 0];
const RtmpPacket = {
  create: (fmt = 0, cid = 0) => {
    return {
      header: {
        fmt: fmt,
        cid: cid,
        timestamp: 0,
        length: 0,
        type: 0,
        stream_id: 0,
      },
      clock: 0,
      payload: null,
      capacity: 0,
      bytes: 0,
    };
  },
};

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
    this.previousChunk = {};
    this.inChunkSize = 128;
    this.outChunkSize = 128;
    this.connectCmdObj = {};
    this.objectEncoding = {};
  }

  // 绑定一下事件
  run() {
    this.socket.on("data", this.onData.bind(this));
  }

  // 处理data
  onData(data) {
    Logger.log("onData", data.length);
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

    /* 消息格式
    C0和S0报文只有一个字节，也就是8-bit的字段:
    0 1 2 3 4 5 6 7
    +-+-+-+-+-+-+-+-+ 
    |     version   | 
    +-+-+-+-+-+-+-+-+
    C0 and S0 bits


    C1和S1包是1536字节长，由一下字段组成:
    0                    1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        time (4 bytes)                         | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        zero (4 bytes)                         | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        random bytes                           | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        random bytes                           | 
    |                            (cont)                             | 
    |                             ....                              | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

    C2和S2都是1536字节长，是对S1/C1分别的回复，由以下字段组成:
    0                   1                   2                     3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        time (4 bytes)                         | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        time2 (4 bytes)                        | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        random echo                            | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                        random echo                            | 
    |                           (cont)                              |
    |                            ....                               | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    C2 and S2 bits
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
        const offset = data.length > 1536 ? 1536 : 0;
        const cData = data.slice(offset);
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
    Logger.log("rtmpChunkRead", data.length);
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
    const chunkBasicHeader = data.slice(0, 1); // 一个字节=8bit = 上面的任意一种
    const formatType = chunkBasicHeader[0] >> 6; // 右位移6位取前2位
    let chunkStreamID = chunkBasicHeader[0] & 0x3f; // 0x3f=0b111111,且操作,取后六位
    Logger.log("chunkBasicHeader", chunkBasicHeader);
    Logger.log("formatType", formatType);
    Logger.log("chunkStreamID", chunkStreamID);
    let parserBytesOffset = 1; // 预设值,因为还有可能是3字节
    // 根据上面header结构,重新新取值
    switch (chunkStreamID) {
      // 0b000000 & 0b111111 = 0, 所以是情况2: Basic Header占用2个字节，CSID在［64，319］之间
      case 0: {
        chunkStreamID = data[1] + 64;
        parserBytesOffset = 2;
        break;
      }
      // 0b000001 & 0b111111 = 1, 所以是情况3: Basic Header占用3个字节，CSID在［64，65599］之间
      case 1: {
        chunkStreamID = (data[1] << 8) + data[2] + 64;
        parserBytesOffset = 3;
        break;
      }
      // 剩下就是情况1, 该chunk是控制信息和一些命令信息
      // case 2: {
      //   break;
      // }
    }

    Logger.log("parserBytesOffset", parserBytesOffset);

    /* ----- 解析Message Header -----
    格式和长度取决于Basic Header的chunk type，共有4种不同的格式

    Type 0 chunk header是11字节长。这个type 0类型必须是在chunk stream的最开始使用，并且无论什么时候stream timestamp都应该是向后发展的
    0               1               2               3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2
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


    Type 1 chunk headers是7字节长。message stream ID不在其内。
    这个chunk带有上个chunk相同的chunk stream id。
    流都是变长的消息(举例，多种视频格式)应该用这个格式作为第二个stream的chunk报文。
    0               1               2               3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                timestamp delta                |message length | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |      message length (cont)    |message type id| 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    Chunk Message Header - Type 1


    Type 2chunk headers是3字节长。stream ID和message length都不包含；
    chunk有与前一个chunk相同的stream ID和message length。
    流是定长的消息(例如，音频和数据格式)应该用这个类型，作为第二个stream的chunk报文。
    0               1               2
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+ 
    |                timestamp delta                | 
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    Chunk Message Header - Type 2


    Type 3其实没有message header。
    stream ID，message length和timestamp都不存在。
    这个chunk类型都继承前一个相同chunk stream ID的chunk所有字段。
    当单个消息被切分多个chunk，所有的消息除了第一个chunk外都用这个类型。

    */
    // 消息头
    const message = {
      timestamp: 0,
      messageLength: 0,
      messageTypeID: 0,
      messageStreamID: 0,
      timestampDelta: 0,
    };
    switch (formatType) {
      case 0: {
        const chunkMessageHeader = data.slice(parserBytesOffset);
        message.timestamp = chunkMessageHeader.readIntBE(0, 3);
        message.messageLength = chunkMessageHeader.readIntBE(3, 3);
        message.messageTypeID = chunkMessageHeader[6];
        message.messageStreamID = chunkMessageHeader.readInt32LE(7);
        this.previousChunk[chunkStreamID] = message;
        parserBytesOffset += 11;
        break;
      }
      case 1: {
        const chunkMessageHeader = data.slice(parserBytesOffset);
        message.timestampDelta = chunkMessageHeader.readIntBE(0, 3);
        message.timestamp = this.previousChunk[chunkStreamID].timestamp;
        message.messageLength = chunkMessageHeader.readIntBE(3, 3);
        message.messageTypeID = chunkMessageHeader[6];
        message.messageStreamID = this.previousChunk[chunkStreamID].messageStreamID;
        this.previousChunk[chunkStreamID] = message;
        parserBytesOffset += 7;
        break;
      }
      case 2: {
        const chunkMessageHeader = data.slice(parserBytesOffset);
        message.timestampDelta = chunkMessageHeader.readIntBE(0, 3);
        message.timestamp = this.previousChunk[chunkStreamID].timestamp;
        message.messageLength = this.previousChunk[chunkStreamID].messageLength;
        message.messageTypeID = this.previousChunk[chunkStreamID].messageTypeID;
        message.messageStreamID = this.previousChunk[chunkStreamID].messageStreamID;
        this.previousChunk[chunkStreamID] = message;
        parserBytesOffset += 7;
        break;
      }
      // 剩下3继承前一个相同chunk stream ID的chunk所有字段
      case 3: {
        message = { ...this.previousChunk[chunkStreamID] };
        this.previousChunk[chunkStreamID] = message;
        break;
      }
    }

    Logger.log("message", message);
    Logger.log("parserBytesOffset", parserBytesOffset);

    /* ----- 解析Extended Timestamp Header -----
    extended timestamp字段用于timestamp字段大于等于16777215(0xFFFFFF)；
    那是为了时间戳不能满足于在type0,1,2 chunk中24bits大小的字段。
    这个字段是完整的32bit的时间戳或时间戳差值。
    这个字段在chunk type 0中表示时间戳，或type-1或type-2 chunk中表示timestamp的差值，timestamp字段的值必须是16777215(0xFFFFFF)。
    这个字段当先前使用的type 0, 1, 或2 chunk对同一个chunk stream ID, 表示type3该字段是上次extended timesamp field。
    */
    if (formatType === 0) {
      if (message.timestamp === 0xffffff) {
        const chunkExtendedTimestampHeader = data.slice(parserBytesOffset);
        message.timestamp =
          chunkExtendedTimestampHeader[0] * Math.pow(256, 3) +
          (chunkExtendedTimestampHeader[1] << 16) +
          (chunkExtendedTimestampHeader[2] << 8) +
          chunkExtendedTimestampHeader[3];
        parserBytesOffset += 4;
      }
    } else if (message.timestampDelta === 0xffffff) {
      const chunkExtendedTimestampHeader = data.slice(parserBytesOffset);
      message.timestampDelta =
        chunkExtendedTimestampHeader[0] * Math.pow(256, 3) +
        (chunkExtendedTimestampHeader[1] << 16) +
        (chunkExtendedTimestampHeader[2] << 8) +
        chunkExtendedTimestampHeader[3];
      parserBytesOffset += 4;
    }

    Logger.log("parserBytesOffset", parserBytesOffset);

    /* ----- 解析Chunk Data ----- 
    这部分数据是用户实际要传的，与RTMP协议本身无关
    长度在(0,chunkSize)之间
    */
    const chunkData = data.slice(parserBytesOffset);
    Logger.log(parserBytesOffset, data, chunkData);

    this.handleRtmpMessage(message, chunkData);
  }

  /* ----- 处理RtmpMessage ----- 
  设置块类型 (1)
  终止消息（2）
  确认 (3)
  用户控制消息 (4)
  窗口确认大小 (5)
  设置对端带宽 (6)
  音频消息 (8)
  视频消息 (9)
  数据消息 (18, 15)
  共享对象消息 (19, 16)
  命令消息 (20, 17)
  统计消息 (22)
  */
  handleRtmpMessage(message, rtmpBody) {
    console.log(message, rtmpBody);
    const { timestamp, messageLength, messageTypeID, messageStreamID, timestampDelta } = message;
    switch (messageTypeID) {
      case 0x01:
        this.inChunkSize = rtmpBody.readUInt32BE(0);
        //console.log('[rtmp handleRtmpMessage] Set In chunkSize:' + this.inChunkSize);
        break;

      case 0x04:
        var userControlMessage = this.parseUserControlMessage(rtmpBody);
        if (userControlMessage.eventType === 3) {
          var streamID =
            (userControlMessage.eventData[0] << 24) +
            (userControlMessage.eventData[1] << 16) +
            (userControlMessage.eventData[2] << 8) +
            userControlMessage.eventData[3];
          var bufferLength =
            (userControlMessage.eventData[4] << 24) +
            (userControlMessage.eventData[5] << 16) +
            (userControlMessage.eventData[6] << 8) +
            userControlMessage.eventData[7];
          // //console.log("[rtmp handleRtmpMessage] SetBufferLength: streamID=" + streamID + " bufferLength=" + bufferLength);
        } else if (userControlMessage.eventType === 7) {
          var timestamp =
            (userControlMessage.eventData[0] << 24) +
            (userControlMessage.eventData[1] << 16) +
            (userControlMessage.eventData[2] << 8) +
            userControlMessage.eventData[3];
          ////console.log("[rtmp handleRtmpMessage] PingResponse: timestamp=" + timestamp);
        } else {
          // //console.log("[rtmp handleRtmpMessage] User Control Message");
          //console.log(userControlMessage);
        }
        break;

      /*
       * 视频/音频数据(Audio Data & Video Data)
       */
      case 0x08:
        // 音频数据(Audio Data)
        ////console.log(rtmpHeader);
        // //console.log('Audio Data: '+rtmpBody.length);\
        this.parseAudioMessage(rtmpHeader, rtmpBody);
        break;
      case 0x09:
        // 视频数据(Video Data)
        // //console.log(rtmpHeader);
        // //console.log('Video Data: '+rtmpBody.length);
        this.parseVideoMessage(rtmpHeader, rtmpBody);
        break;

      /*
       * 共享消息(Shared Object Message)
       * 含义：表示一个Flash类型的对象，由键值对的集合组成，用于多客户端，多实例时使用
       *
       * MessageTypeID = 19(0x13) 或 16(0x10)
       *         当信息使用AMF0编码时，MessageTypeID=19(0x13)
       *         当信息使用AMF3编码时，MessageTypeID=16(0x10)
       */
      case 0x10:
      case 0x13:
        // do nothing
        break;

      /*
       * 命令消息(Command Message)
       * 含义：在客户端盒服务器间传递的在对端执行某些操作的命令消息
       *
       * MessageTypeID = 17(0x11) 或 20(0x14)
       *         当信息使用AMF0编码时，MessageTypeID=20(0x14)
       *         当信息使用AMF3编码时，MessageTypeID=17(0x11)
       *
       * 常见的Command Message含义
       *        connect: 连接对端，对端如果同意连接的话会记录发送端信息并返回连接成功消息
       *        publish: 开始向对方推流，接受端接到命令后准备好接受对端发送的流信息
       */
      case 0x11:
        //AMF3 encoded Command Message
        var cmd = AMF.decodeAmf0Cmd(rtmpBody.slice(1));
        this.handleAMFCommandMessage(cmd, this);
        break;
      case 0x14:
        //AMF0 encoded Command Message
        var cmd = AMF.decodeAmf0Cmd(rtmpBody);
        this.handleAMFCommandMessage(cmd, this);
        break;

      /*
       * 数据消息(Data Message)。
       * 含义：传递一些元数据（MetaData，比如视频名，分辨率等等）或者用户自定义的一些消息。
       *
       * MessageTypeID = 15(0x0F) 或 18(0x12)
       *         当信息使用AMF0编码时，MessageTypeID=18(0x14)
       *         当信息使用AMF3编码时，MessageTypeID=15(0x0F)
       */
      case 0x0f:
        //AMF3 encoded Data Message
        var cmd = AMF.decodeAmf0Cmd(rtmpBody.slice(1));
        this.handleAMFDataMessage(cmd, this);
        break;
      case 0x12:
        //AMF0 encoded Data Message
        var cmd = AMF.decodeAmf0Cmd(rtmpBody);
        this.handleAMFDataMessage(cmd, this);
        break;
    }
  }

  handleAMFCommandMessage(cmd) {
    switch (cmd.cmd) {
      case "connect": {
        this.connectCmdObj = cmd.cmdObj;
        this.objectEncoding = cmd.cmdObj.objectEncoding != null ? cmd.cmdObj.objectEncoding : 0;
        this.sendWindowACK(5000000);
        this.setPeerBandwidth(5000000, 2);
        this.outChunkSize = 4096;
        this.setChunkSize(this.outChunkSize);
        this.respondConnect();
        Logger.log("connect");
        break;
      }
    }
  }

  sendWindowACK(size) {
    let rtmpBuffer = Buffer.from("02000000000004050000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    this.socket.write(rtmpBuffer);
  }

  setPeerBandwidth(size, type) {
    let rtmpBuffer = Buffer.from("0200000000000506000000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    rtmpBuffer[16] = type;
    this.socket.write(rtmpBuffer);
  }

  setChunkSize(size) {
    let rtmpBuffer = Buffer.from("02000000000004010000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    this.socket.write(rtmpBuffer);
  }

  respondConnect(tid) {
    let opt = {
      cmd: "_result",
      transId: tid,
      cmdObj: {
        fmsVer: "FMS/3,0,1,123",
        capabilities: 31,
      },
      info: {
        level: "status",
        code: "NetConnection.Connect.Success",
        description: "Connection succeeded.",
        objectEncoding: this.objectEncoding,
      },
    };
    this.sendInvokeMessage(0, opt);
  }

  sendInvokeMessage(sid, opt) {
    let packet = RtmpPacket.create();
    packet.header.fmt = 0;
    packet.header.cid = 4;
    packet.header.type = 20;
    packet.header.stream_id = sid;
    packet.payload = AMF.encodeAmf0Cmd(opt);
    packet.header.length = packet.payload.length;
    let chunks = this.rtmpChunksCreate(packet);
    this.socket.write(chunks);
  }

  rtmpChunksCreate(packet) {
    let header = packet.header;
    let payload = packet.payload;
    let payloadSize = header.length;
    let chunkSize = this.outChunkSize;
    let chunksOffset = 0;
    let payloadOffset = 0;
    let chunkBasicHeader = this.rtmpChunkBasicHeaderCreate(header.fmt, header.cid);
    let chunkBasicHeader3 = this.rtmpChunkBasicHeaderCreate(3, header.cid);
    let chunkMessageHeader = this.rtmpChunkMessageHeaderCreate(header);
    let useExtendedTimestamp = header.timestamp >= 0xffffff;
    let headerSize = chunkBasicHeader.length + chunkMessageHeader.length + (useExtendedTimestamp ? 4 : 0);
    let n = headerSize + payloadSize + Math.floor(payloadSize / chunkSize);

    if (useExtendedTimestamp) {
      n += Math.floor(payloadSize / chunkSize) * 4;
    }
    if (!(payloadSize % chunkSize)) {
      n -= 1;
      if (useExtendedTimestamp) {
        //TODO CHECK
        n -= 4;
      }
    }

    let chunks = Buffer.alloc(n);
    chunkBasicHeader.copy(chunks, chunksOffset);
    chunksOffset += chunkBasicHeader.length;
    chunkMessageHeader.copy(chunks, chunksOffset);
    chunksOffset += chunkMessageHeader.length;
    if (useExtendedTimestamp) {
      chunks.writeUInt32BE(header.timestamp, chunksOffset);
      chunksOffset += 4;
    }
    while (payloadSize > 0) {
      if (payloadSize > chunkSize) {
        payload.copy(chunks, chunksOffset, payloadOffset, payloadOffset + chunkSize);
        payloadSize -= chunkSize;
        chunksOffset += chunkSize;
        payloadOffset += chunkSize;
        chunkBasicHeader3.copy(chunks, chunksOffset);
        chunksOffset += chunkBasicHeader3.length;
        if (useExtendedTimestamp) {
          chunks.writeUInt32BE(header.timestamp, chunksOffset);
          chunksOffset += 4;
        }
      } else {
        payload.copy(chunks, chunksOffset, payloadOffset, payloadOffset + payloadSize);
        payloadSize -= payloadSize;
        chunksOffset += payloadSize;
        payloadOffset += payloadSize;
      }
    }
    return chunks;
  }

  rtmpChunkBasicHeaderCreate(fmt, cid) {
    let out;
    if (cid >= 64 + 255) {
      out = Buffer.alloc(3);
      out[0] = (fmt << 6) | 1;
      out[1] = (cid - 64) & 0xff;
      out[2] = ((cid - 64) >> 8) & 0xff;
    } else if (cid >= 64) {
      out = Buffer.alloc(2);
      out[0] = (fmt << 6) | 0;
      out[1] = (cid - 64) & 0xff;
    } else {
      out = Buffer.alloc(1);
      out[0] = (fmt << 6) | cid;
    }
    return out;
  }

  rtmpChunkMessageHeaderCreate(header) {
    let out = Buffer.alloc(rtmpHeaderSize[header.fmt % 4]);
    if (header.fmt <= 2) {
      out.writeUIntBE(header.timestamp >= 0xffffff ? 0xffffff : header.timestamp, 0, 3);
    }

    if (header.fmt <= 1) {
      out.writeUIntBE(header.length, 3, 3);
      out.writeUInt8(header.type, 6);
    }

    if (header.fmt === 0) {
      out.writeUInt32LE(header.stream_id, 7);
    }
    return out;
  }
}

// 启动服务监听一下端口
server.listen(port, () => {
  console.clear();
  console.log(`start on rtmp://localhost`);
  console.log(`run 'ffmpeg -re -i ~/Downloads/bangbang.mp4 -f flv rtmp://127.0.0.1/live/aaa'`);
});

server.on("error", (e) => {
  console.error(`Node Media Rtmp Server ${e}`);
});

server.on("close", () => {
  console.log("Node Media Rtmp Server Close.");
});
