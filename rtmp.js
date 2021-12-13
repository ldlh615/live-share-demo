//  Created by Mingliang Chen on 15/1/16.
//  Copyright (c) 2015 Nodemedia. All rights reserved.

var NMRtmpHandshake = require("./nm_rtmp_handshake");
var AMF = require("./nm_rtmp_amf");
var BufferPool = require("./nm_bufferpool");

var aac_sample_rates = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0,
];

function NMRtmpConn(id, socket, conns, producers) {
  this.id = id;
  this.socket = socket;
  this.conns = conns;
  this.producers = producers;
  this.rtmpStatus = 0;
  this.isStarting = false;
  this.inChunkSize = 128;
  this.outChunkSize = 128;
  this.previousChunkMessage = {};
  this.connectCmdObj = null;
  this.isFirstAudioReceived = true;
  this.isFirstVideoReceived = true;
  this.lastAudioTimestamp = 0;
  this.lastVideoTimestamp = 0;

  this.playStreamName = "";
  this.publishStreamName = "";

  this.bp = new BufferPool();
  this.bp.on("error", function () {});

  this.parser = parseRtmpMessage(this);

  this.codec = {
    width: 0,
    height: 0,
    duration: 0,
    framerate: 0,
    videodatarate: 0,
    audiosamplerate: 0,
    audiosamplesize: 0,
    audiodatarate: 0,
    spsLen: 0,
    sps: null,
    ppsLen: 0,
    pps: null,
  };

  this.sendBufferQueue = [];

  NMRtmpConn.prototype.run = function () {
    this.isStarting = true;
    this.bp.init(this.parser);
  };

  NMRtmpConn.prototype.stop = function () {
    this.isStarting = false;
    if (this.publishStreamName != "") {
      //console.info("Send Stream EOF to publiser's consumers. Stream name " + this.publishStreamName);
      for (var id in this.consumers) {
        this.consumers[id].sendStreamEOF();
      }
      //console.info("Delete publiser from producers. Stream name " + this.publishStreamName);
      delete this.producers[this.publishStreamName];
    } else if (this.playStreamName != "") {
      if (this.producers[this.playStreamName]) {
        //console.info("Delete player from consumers. Stream name " + this.playStreamName);
        delete this.producers[this.playStreamName].consumers[this.id];
      }
    }
    //console.info("Delete client from conns. ID: " + this.id);
    delete this.conns[this.id];
  };

  NMRtmpConn.prototype.getRealChunkSize = function (rtmpBodySize, chunkSize) {
    var nn = rtmpBodySize + parseInt(rtmpBodySize / chunkSize);
    if (rtmpBodySize % chunkSize) {
      return nn;
    } else {
      return nn - 1;
    }
  };

  function* parseRtmpMessage(self) {
    /* ----------------- RTMP 协议介绍 ---------------- */
    // 资料来源：http://mingyangshang.github.io/2016/03/06/RTMP%E5%8D%8F%E8%AE%AE/

    /*
     * RTMP协议是Real Time Message Protocol(实时信息传输协议)的缩写
     * 由Adobe公司提出的一种应用层的协议，用来解决多媒体数据传输流的多路复用（Multiplexing）和分包（packetizing）的问题
     *
     * RTMP协议是应用层协议，是要靠底层可靠的传输层协议（通常是TCP）来保证信息传输的可靠性的。
     * 在基于传输层协议的链接建立完成后，RTMP协议也要客户端和服务器通过“握手(handshake)”来建立基于传输层链接之上的RTMP Connection链接
     * 在Connection链接上会传输一些控制信息，如SetChunkSize,SetACKWindowSize。
     *   其中CreateStream命令会创建一个Stream链接，用于传输具体的音视频数据和控制这些信息传输的命令信息。
     *
     * RTMP协议传输时会对数据做自己的格式化，这种格式的消息我们称之为RTMP Message
     * 而实际传输的时候为了更好地实现多路复用、分包和信息的公平性，发送端会把Message划分为带有Message ID的Chunk
     * 每个Chunk可能是一个单独的Message，也可能是Message的一部分
     * 在接受端会根据chunk中包含的data的长度，message id和message的长度把chunk还原成完整的Message，从而实现信息的收发。
     */

    console.log("rtmp handshake [start]");
    if (self.bp.need(1537)) {
      yield;
    }
    var c0c1 = self.bp.read(1537);
    var s0s1s2 = NMRtmpHandshake.generateS0S1S2(c0c1);
    self.socket.write(s0s1s2);
    if (self.bp.need(1536)) {
      yield;
    }
    var c2 = self.bp.read(1536);
    console.log("rtmp handshake [ok]");

    while (self.isStarting) {
      var message = {};
      var chunkMessageHeader = null;
      var previousChunk = null;
      var pos = 0;
      if (self.bp.need(1)) {
        yield;
      }

      /* ----- 开始解析块(Chunk) ----- */
      /*
             # 发送端把RTMP Message划分为一个个Chunk，意味着Chunk就是传输过程数据的最小单位。
               所以，解析RTMP Message，就是解析Chunk

             # 下面给出了块(Chunk)的标准格式
             +--------------+----------------+--------------------+---------------------------------------+
             | Basic Header | Message Header | Extended Timestamp |                Chunk Data             |
             +--------------+----------------+--------------------+---------------------------------------+
             |<------------------- Chunk Header ----------------->|

             # 可以看出，一个块(chunk)是由块头(Chunk Header)和块数据(Chunk Data)组成的
             # 而块头(Chunk Header)则包含有 基本头(Basic Header)、消息头(Message Header)和拓展时间戳(Extended Timestamp)信息
             */

      /* 解析 基本的头信息(Basic Header) */
      var chunkBasicHeader = self.bp.read(1);
      message.formatType = chunkBasicHeader[0] >> 6;
      message.chunkStreamID = chunkBasicHeader[0] & 0x3f;
      // Chunk Stream ID（流通道Id）和chunk type（chunk的类型），一般被简写为CSID，用来唯一标识一个特定的流通道
      // 0: Basic Header占用2个字节，CSID在［64，319］之间
      // 1: Basic Header占用3个字节，CSID在［64，65599］之间
      // 2: 该chunk是控制信息和一些命令信息
      if (message.chunkStreamID == 0) {
        if (self.bp.need(1)) {
          yield;
        }
        var exStreamID = self.bp.read(1);
        message.chunkStreamID = exStreamID[0] + 64;
      } else if (message.chunkStreamID == 1) {
        if (self.bp.need(2)) {
          yield;
        }
        var exStreamID = self.bp.read(2);
        message.chunkStreamID = (exStreamID[0] << 8) + exStreamID[1] + 64;
      }

      /* 解析 消息的头信息(Message Header) */
      // 格式和长度取决于Basic Header的chunk type，共有4种不同的格式
      if (message.formatType == 0) {
        // type=0时，共占用11个字节
        if (self.bp.need(11)) {
          yield;
        }
        chunkMessageHeader = self.bp.read(11);

        // 时间戳: 占用3个字节
        // 它最多能表示到16777215=0xFFFFFF=224-1
        // 当它的值超过这个最大值时，这三个字节都置为1
        // 此时实际的timestamp会转存到Extended Timestamp字段中，接受端在判断timestamp字段24个位都为1时就会去Extended timestamp中解析实际的时间戳。
        message.timestamp = chunkMessageHeader.readIntBE(0, 3);

        message.timestampDelta = 0;

        // 消息数据的长度: 占用3个字节，表示实际发送的消息的数据如音频帧、视频帧等数据的长度，单位是字节
        message.messageLength = chunkMessageHeader.readIntBE(3, 3);

        // 消息的类型id: 占用1个字节，表示实际发送的数据的类型，如8代表音频数据、9代表视频数据(具体在 handleRtmpMessage 函数中说明)
        message.messageTypeID = chunkMessageHeader[6];

        // 消息的流id: 占用4个字节，表示该chunk所在的流的ID，和Basic Header的CSID一样，它采用小端存储的方式
        message.messageStreamID = chunkMessageHeader.readInt32LE(7);
      } else if (message.formatType == 1) {
        // type=0时，共占用7个字节
        // 省去了表示msg stream id的4个字节
        // 表示此chunk和上一次发的chunk所在的流相同
        // 如果在发送端只和对端有一个流链接的时候可以尽量去采取这种格式。
        if (self.bp.need(7)) {
          yield;
        }
        chunkMessageHeader = self.bp.read(7);

        // 占用3个字节
        // 这里和type＝0时不同，存储的是和上一个chunk的时间差
        // 类似上面提到的timestamp，当它的值超过3个字节所能表示的最大值时，三个字节都置为1，
        // 实际的时间戳差值就会转存到Extended Timestamp字段中，接受端在判断timestamp delta字段24个位都为1时就会去Extended timestamp中解析时机的与上次时间戳的差值。
        message.timestampDelta = chunkMessageHeader.readIntBE(0, 3);
        message.messageLength = chunkMessageHeader.readIntBE(3, 3);
        message.messageTypeID = chunkMessageHeader[6];
        previousChunk = self.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
        } else {
          throw new Error(
            "Chunk reference error for type 1: previous chunk for id " + message.chunkStreamID + " is not found"
          );
        }
      } else if (message.formatType == 2) {
        // type=2时，共占用3个字节
        // 相对于type=1格式又省去了表示消息长度的3个字节(messageLength)和表示消息类型的1个字节(messageTypeID)
        // 表示此chunk和上一次发送的chunk所在的流、消息的长度和消息的类型都相同。
        // 余下的这三个字节表示timestamp delta，使用同type＝1
        if (self.bp.need(3)) {
          yield;
        }
        chunkMessageHeader = self.bp.read(3);
        message.timestampDelta = chunkMessageHeader.readIntBE(0, 3);
        previousChunk = self.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.messageTypeID = previousChunk.messageTypeID;
        } else {
          throw new Error(
            "Chunk reference error for type 2: previous chunk for id " + message.chunkStreamID + " is not found"
          );
        }
      } else if (message.formatType == 3) {
        // type=3时，共占用0个字节
        // 它表示这个chunk的Message Header和上一个是完全相同的，自然就不用再传输一遍了。

        // 当它跟在Type＝0的chunk后面时，表示和前一个chunk的时间戳都是相同的。
        //         什么时候连时间戳都相同呢？就是一个Message拆分成了多个chunk，这个chunk和上一个chunk同属于一个Message。

        // 当它跟在Type＝1或者Type＝2的chunk后面时，表示和前一个chunk的时间戳的差是相同的。

        // 比如第一个chunk的Type＝0，timestamp＝100，第二个chunk的Type＝2，timestamp delta＝20，表示时间戳为100+20=120，第三个chunk的Type＝3，表示timestamp delta＝20，时间戳为120+20=140
        previousChunk = self.previousChunkMessage[message.chunkStreamID];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.timestampDelta = previousChunk.timestampDelta;
          message.messageTypeID = previousChunk.messageTypeID;
        } else {
          throw new Error(
            "Chunk reference error for type 3: previous chunk for id " + message.chunkStreamID + " is not found"
          );
        }
      } else {
        // type不等于0，1，2，3时，此chunk无效
        throw new Error("Unknown format type: " + message.formatType);
      }

      // 拓展时间戳(Extended Timestamp)
      // 在chunk中会有时间戳timestamp和时间戳差timestamp delta，并且它们不会同时存在，只有这两者之一大于3个字节能表示的最大数值0xFFFFFF＝16777215时，才会用这个字段来表示真正的时间戳，否则这个字段为0。
      // 扩展时间戳占4个字节，能表示的最大数值就是0xFFFFFFFF＝4294967295。
      // 当扩展时间戳启用时，timestamp字段或者timestamp delta全为1，表示应该去扩展时间戳字段来提取真正的时间戳或者时间戳差。
      // 注意扩展时间戳存储的是完整值，而不是减去时间戳或者时间戳差的值。
      if (message.formatType === 0) {
        if (message.timestamp === 0xffffff) {
          if (self.bp.need(4)) {
            yield;
          }
          var chunkBodyHeader = self.bp.read(4);
          message.timestamp =
            chunkBodyHeader[0] * Math.pow(256, 3) +
            (chunkBodyHeader[1] << 16) +
            (chunkBodyHeader[2] << 8) +
            chunkBodyHeader[3];
        }
      } else if (message.timestampDelta === 0xffffff) {
        if (self.bp.need(4)) {
          yield;
        }
        var chunkBodyHeader = self.bp.read(4);
        message.timestampDelta =
          chunkBodyHeader[0] * Math.pow(256, 3) +
          (chunkBodyHeader[1] << 16) +
          (chunkBodyHeader[2] << 8) +
          chunkBodyHeader[3];
      }
      // console.log(message);

      /* 解析 块数据(Chunk Data) */
      // 这部分数据是用户实际要传的，与RTMP协议本身无关
      // 长度在(0,chunkSize]之间
      var rtmpBody = [];
      var rtmpBodySize = message.messageLength;
      var chunkBodySize = self.getRealChunkSize(rtmpBodySize, self.inChunkSize);
      if (self.bp.need(chunkBodySize)) {
        yield;
      }
      var chunkBody = self.bp.read(chunkBodySize);
      var chunkBodyPos = 0;
      do {
        if (rtmpBodySize > self.inChunkSize) {
          rtmpBody.push(chunkBody.slice(chunkBodyPos, chunkBodyPos + self.inChunkSize));
          rtmpBodySize -= self.inChunkSize;
          chunkBodyPos += self.inChunkSize;
          chunkBodyPos++;
        } else {
          rtmpBody.push(chunkBody.slice(chunkBodyPos, chunkBodyPos + rtmpBodySize));
          rtmpBodySize -= rtmpBodySize;
          chunkBodyPos += rtmpBodySize;
        }
      } while (rtmpBodySize > 0);

      message.timestamp += message.timestampDelta;
      self.previousChunkMessage[message.chunkStreamID] = message;
      var rtmpBodyBuf = Buffer.concat(rtmpBody);
      self.handleRtmpMessage(message, rtmpBodyBuf);
    }
  }

  NMRtmpConn.prototype.createRtmpMessage = function (rtmpHeader, rtmpBody) {
    var formatTypeID = 0;
    var rtmpBodySize = rtmpBody.length;
    if (rtmpHeader.chunkStreamID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): chunkStreamID is not set for RTMP message");
    }
    if (rtmpHeader.timestamp == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): timestamp is not set for RTMP message");
    }
    if (rtmpHeader.messageTypeID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): messageTypeID is not set for RTMP message");
    }
    if (rtmpHeader.messageStreamID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): messageStreamID is not set for RTMP message");
    }

    var useExtendedTimestamp = false;
    var timestamp;

    if (rtmpHeader.timestamp >= 0xffffff) {
      useExtendedTimestamp = true;
      timestamp = [0xff, 0xff, 0xff];
    } else {
      timestamp = [
        (rtmpHeader.timestamp >> 16) & 0xff,
        (rtmpHeader.timestamp >> 8) & 0xff,
        rtmpHeader.timestamp & 0xff,
      ];
    }

    var bufs = new Buffer([
      (formatTypeID << 6) | rtmpHeader.chunkStreamID,
      timestamp[0],
      timestamp[1],
      timestamp[2],
      (rtmpBodySize >> 16) & 0xff,
      (rtmpBodySize >> 8) & 0xff,
      rtmpBodySize & 0xff,
      rtmpHeader.messageTypeID,
      rtmpHeader.messageStreamID & 0xff,
      (rtmpHeader.messageStreamID >>> 8) & 0xff,
      (rtmpHeader.messageStreamID >>> 16) & 0xff,
      (rtmpHeader.messageStreamID >>> 24) & 0xff,
    ]);

    if (useExtendedTimestamp) {
      var extendedTimestamp = new Buffer([
        (rtmpHeader.timestamp >> 24) & 0xff,
        (rtmpHeader.timestamp >> 16) & 0xff,
        (rtmpHeader.timestamp >> 8) & 0xff,
        rtmpHeader.timestamp & 0xff,
      ]);
      bufs = Buffer.concat([bufs, extendedTimestamp]);
    }

    var rtmpBodyPos = 0;
    var chunkBodySize = this.getRealChunkSize(rtmpBodySize, this.outChunkSize);
    var chunkBody = [];
    var type3Header = new Buffer([(3 << 6) | rtmpHeader.chunkStreamID]);

    do {
      if (rtmpBodySize > this.outChunkSize) {
        chunkBody.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + this.outChunkSize));
        rtmpBodySize -= this.outChunkSize;
        rtmpBodyPos += this.outChunkSize;
        chunkBody.push(type3Header);
      } else {
        chunkBody.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + rtmpBodySize));
        rtmpBodySize -= rtmpBodySize;
        rtmpBodyPos += rtmpBodySize;
      }
    } while (rtmpBodySize > 0);
    var chunkBodyBuffer = Buffer.concat(chunkBody);
    bufs = Buffer.concat([bufs, chunkBodyBuffer]);
    return bufs;
  };

  NMRtmpConn.prototype.handleRtmpMessage = function (rtmpHeader, rtmpBody) {
    switch (rtmpHeader.messageTypeID) {
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
  };

  NMRtmpConn.prototype.handleAMFDataMessage = function (cmd) {
    switch (cmd.cmd) {
      case "@setDataFrame":
        this.receiveSetDataFrame(cmd.method, cmd.cmdObj);
        break;
      default:
      //console.warn("[rtmp:receive] unknown AMF data: " + dataMessage.objects[0].value);
    }
  };

  NMRtmpConn.prototype.handleAMFCommandMessage = function (cmd) {
    switch (cmd.cmd) {
      case "connect":
        this.connectCmdObj = cmd.cmdObj;
        this.objectEncoding = cmd.cmdObj.objectEncoding != null ? cmd.cmdObj.objectEncoding : 0;
        this.windowACK(5000000);
        this.setPeerBandwidth(5000000, 2);
        this.outChunkSize = 4096;
        this.setChunkSize(this.outChunkSize);
        this.respondConnect();
        console.log("rtmp connect app: " + this.connectCmdObj.app);
        break;
      case "createStream":
        this.respondCreateStream(cmd);
        break;
      case "play":
        var streamName = this.connectCmdObj.app + "/" + cmd.streamName;
        console.log("rtmp play stream: " + cmd.streamName);
        this.respondPlay();
        this.playStreamName = streamName;

        if (!this.producers[streamName]) {
          //console.info("[rtmp streamPlay]  There's no stream named " + streamName + " is publushing! Create a producer.");
          this.producers[streamName] = {
            id: null,
            consumers: {},
          };
        } else if (this.producers[streamName].id == null) {
          //console.info("[rtmp streamPlay]  There's no stream named " + streamName + " is publushing! But the producer is created.");
        } else {
          //console.info("[rtmp streamPlay]  There's a  stream named " + streamName + " is publushing! id=" + this.producers[streamName].id);
        }
        this.producers[streamName].consumers[this.id] = this;
        this.startPlay();
        break;
      case "closeStream":
        this.closeStream();
        break;
      case "deleteStream":
        this.deleteStream();
        break;
      case "pause":
        //console.log('pause received');
        this.pauseOrUnpauseStream();
        break;
      case "releaseStream":
        this.respondReleaseStream();
        break;
      case "FCPublish":
        this.respondFCPublish();
        break;
      case "publish":
        var streamName = this.connectCmdObj.app + "/" + cmd.streamName;
        console.log("rtmp publish stream: " + cmd.streamName);
        if (!this.producers[streamName]) {
          this.producers[streamName] = {
            id: this.id,
            consumers: {},
          };
        } else if (this.producers[streamName].id == null) {
          this.producers[streamName].id = this.id;
        } else {
          //console.warn("[rtmp publish] Already has a stream named " + streamName);
          this.respondPublishError();
          return;
        }
        this.publishStreamName = streamName;
        this.producer = this.producers[streamName];
        this.consumers = this.producer.consumers;
        this.respondPublish();
        break;
      case "FCUnpublish":
        this.respondFCUnpublish();
        break;
      default:
        //console.warn("[rtmp:receive] unknown AMF command: " + cmd.cmd);
        break;
    }
  };

  NMRtmpConn.prototype.windowACK = function (size) {
    var rtmpBuffer = new Buffer("02000000000004050000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('windowACK: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  NMRtmpConn.prototype.setPeerBandwidth = function (size, type) {
    var rtmpBuffer = new Buffer("0200000000000506000000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    rtmpBuffer[16] = type;
    // //console.log('setPeerBandwidth: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  NMRtmpConn.prototype.setChunkSize = function (size) {
    var rtmpBuffer = new Buffer("02000000000004010000000000000000", "hex");
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('setChunkSize: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  NMRtmpConn.prototype.respondConnect = function () {
    var rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 0,
    };
    var opt = {
      cmd: "_result",
      transId: 1,
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
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.respondRejectConnect = function (first_argument) {
    var rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 0,
    };

    var opt = {
      cmd: "_error",
      transId: 1,
      cmdObj: {
        fmsVer: "FMS/3,0,1,123",
        capabilities: 31,
      },
      info: {
        level: "error",
        code: "NetConnection.Connect.Rejected",
        description: "Connection failed.",
        objectEncoding: this.objectEncoding,
      },
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.respondCreateStream = function (cmd) {
    // //console.log(cmd);
    var rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 0,
    };
    var opt = {
      cmd: "_result",
      transId: cmd.transId,
      cmdObj: null,
      info: 1,
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.respondPlay = function () {
    var rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 1,
    };
    var opt = {
      cmd: "onStatus",
      transId: 0,
      cmdObj: null,
      info: {
        level: "status",
        code: "NetStream.Play.Start",
        description: "Start live",
      },
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);

    var rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x12,
      messageStreamID: 1,
    };
    var opt = {
      cmd: "|RtmpSampleAccess",
      bool1: true,
      bool2: true,
    };

    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.startPlay = function () {
    var producer = this.producers[this.playStreamName];
    if (
      producer.metaData == null ||
      producer.cacheAudioSequenceBuffer == null ||
      producer.cacheVideoSequenceBuffer == null
    )
      return;

    var rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x12,
      messageStreamID: 1,
    };

    var opt = {
      cmd: "onMetaData",
      cmdObj: producer.metaData,
    };

    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var metaDataRtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);

    var rtmpHeader = {
      chunkStreamID: 4,
      timestamp: 0,
      messageTypeID: 0x08,
      messageStreamID: 1,
    };
    var audioSequenceRtmpMessage = this.createRtmpMessage(rtmpHeader, producer.cacheAudioSequenceBuffer);

    var rtmpHeader = {
      chunkStreamID: 4,
      timestamp: 0,
      messageTypeID: 0x09,
      messageStreamID: 1,
    };
    var videoSequenceRtmpMessage = this.createRtmpMessage(rtmpHeader, producer.cacheVideoSequenceBuffer);

    var beginRtmpMessage = new Buffer("020000000000060400000000000000000001", "hex");
    this.sendBufferQueue.push(beginRtmpMessage);
    this.sendBufferQueue.push(metaDataRtmpMessage);
    this.sendBufferQueue.push(audioSequenceRtmpMessage);
    this.sendBufferQueue.push(videoSequenceRtmpMessage);
    this.sendRtmpMessage(this);
  };

  NMRtmpConn.prototype.closeStream = function () {};

  NMRtmpConn.prototype.deleteStream = function () {};

  NMRtmpConn.prototype.pauseOrUnpauseStream = function () {};

  NMRtmpConn.prototype.respondReleaseStream = function () {};

  NMRtmpConn.prototype.respondFCPublish = function () {};

  NMRtmpConn.prototype.respondPublish = function () {
    var rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 1,
    };
    var opt = {
      cmd: "onStatus",
      transId: 0,
      cmdObj: null,
      info: {
        level: "status",
        code: "NetStream.Publish.Start",
        description: "Start publishing",
      },
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.respondPublishError = function () {
    var rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 1,
    };
    var opt = {
      cmd: "onStatus",
      transId: 0,
      cmdObj: null,
      info: {
        level: "error",
        code: "NetStream.Publish.BadName",
        description: "Already publishing",
      },
    };
    var rtmpBody = AMF.encodeAmf0Cmd(opt);
    var rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  };

  NMRtmpConn.prototype.respondFCUnpublish = function () {};

  NMRtmpConn.prototype.receiveSetDataFrame = function (method, obj) {
    //console.log('[receiveSetDataFrame] method:' + method);

    if (method == "onMetaData") {
      this.producers[this.publishStreamName].metaData = obj;
    }
  };

  NMRtmpConn.prototype.parseUserControlMessage = function (buf) {
    var eventData, eventType;
    var eventType = (buf[0] << 8) + buf[1];
    var eventData = buf.slice(2);
    var message = {
      eventType: eventType,
      eventData: eventData,
    };
    if (eventType === 3) {
      message.streamID = (eventData[0] << 24) + (eventData[1] << 16) + (eventData[2] << 8) + eventData[3];
      message.bufferLength = (eventData[4] << 24) + (eventData[5] << 16) + (eventData[6] << 8) + eventData[7];
    }
    return message;
  };

  NMRtmpConn.prototype.parseAudioMessage = function (rtmpHeader, rtmpBody) {
    if (this.isFirstAudioReceived) {
      var sound_format = rtmpBody[0];
      var sound_type = sound_format & 0x01;
      var sound_size = (sound_format >> 1) & 0x01;
      var sound_rate = (sound_format >> 2) & 0x03;
      sound_format = (sound_format >> 4) & 0x0f;
      if (sound_format != 10) {
        //console.error("Only support audio aac codec. actual=" + sound_format);
        return -1;
      }
      //console.info(this.id + " Parse AudioTagHeader sound_format=" + sound_format + " sound_type=" + sound_type + " sound_size=" + sound_size + " sound_rate=" + sound_rate);
      var aac_packet_type = rtmpBody[1];
      if (aac_packet_type == 0) {
        //AudioSpecificConfig
        // only need to decode  2bytes:
        // audioObjectType, aac_profile, 5bits.
        // samplingFrequencyIndex, aac_sample_rate, 4bits.
        // channelConfiguration, aac_channels, 4bits
        this.codec.aac_profile = rtmpBody[2];
        this.codec.aac_sample_rate = rtmpBody[3];

        this.codec.aac_channels = (this.codec.aac_sample_rate >> 3) & 0x0f;
        this.codec.aac_sample_rate =
          ((this.codec.aac_profile << 1) & 0x0e) | ((this.codec.aac_sample_rate >> 7) & 0x01);
        this.codec.aac_profile = (this.codec.aac_profile >> 3) & 0x1f;
        this.codec.audiosamplerate = aac_sample_rates[this.codec.aac_sample_rate];
        if (this.codec.aac_profile == 0 || this.codec.aac_profile == 0x1f) {
          //console.error("Parse audio aac sequence header failed, adts object=" + this.codec.aac_profile + "invalid.");
          return -1;
        }
        this.codec.aac_profile--;
        //console.info("Parse audio aac sequence header success! ");
        // //console.info(this.codec);
        this.isFirstAudioReceived = false;
        this.producer.cacheAudioSequenceBuffer = new Buffer(rtmpBody);

        for (var id in this.consumers) {
          this.consumers[id].startPlay();
        }
      }
    } else {
      var sendRtmpHeader = {
        chunkStreamID: 4,
        timestamp: rtmpHeader.timestamp,
        messageTypeID: 0x08,
        messageStreamID: 1,
      };
      var rtmpMessage = this.createRtmpMessage(sendRtmpHeader, rtmpBody);

      for (var id in this.consumers) {
        this.consumers[id].sendBufferQueue.push(rtmpMessage);
      }
      /* 
            var frame_length = rtmpBody.length - 2 + 7;
            var audioBuffer = new Buffer(frame_length);
            adts_header.copy(audioBuffer);
            audioBuffer[2] = (this.codec.aac_profile << 6) & 0xc0;
            // sampling_frequency_index 4bits
            audioBuffer[2] |= (this.codec.aac_sample_rate << 2) & 0x3c;
            // channel_configuration 3bits
            audioBuffer[2] |= (this.codec.aac_channels >> 2) & 0x01;
            audioBuffer[3] = (this.codec.aac_channels << 6) & 0xc0;
            // frame_length 13bits
            audioBuffer[3] |= (frame_length >> 11) & 0x03;
            audioBuffer[4] = (frame_length >> 3) & 0xff;
            audioBuffer[5] = ((frame_length << 5) & 0xe0);
            // adts_buffer_fullness; //11bits
            audioBuffer[5] |= 0x1f;
            ////console.log(adts_header.hex());

            rtmpBody.copy(audioBuffer, 7, 2, rtmpBody.length - 2);
            return audioBuffer;
            */
    }
  };

  NMRtmpConn.prototype.parseVideoMessage = function (rtmpHeader, rtmpBody) {
    var index = 0;
    var frame_type = rtmpBody[0];
    var codec_id = frame_type & 0x0f;
    frame_type = (frame_type >> 4) & 0x0f;
    // only support h.264/avc
    if (codec_id != 7) {
      //console.error("Only support video h.264/avc codec. actual=" + codec_id);
      return -1;
    }
    var avc_packet_type = rtmpBody[1];
    var composition_time = rtmpBody.readIntBE(2, 3);
    //  printf("v composition_time %d\n",composition_time);

    if (avc_packet_type == 0) {
      if (this.isFirstVideoReceived) {
        //AVC sequence header
        var configurationVersion = rtmpBody[5];
        this.codec.avc_profile = rtmpBody[6];
        var profile_compatibility = rtmpBody[7];
        this.codec.avc_level = rtmpBody[8];
        var lengthSizeMinusOne = rtmpBody[9];
        lengthSizeMinusOne &= 0x03;
        this.codec.NAL_unit_length = lengthSizeMinusOne;

        //  sps
        var numOfSequenceParameterSets = rtmpBody[10];
        numOfSequenceParameterSets &= 0x1f;

        if (numOfSequenceParameterSets != 1) {
          //console.error("Decode video avc sequenc header sps failed.\n");
          return -1;
        }

        this.codec.spsLen = rtmpBody.readUInt16BE(11);

        index = 11 + 2;
        if (this.codec.spsLen > 0) {
          this.codec.sps = new Buffer(this.codec.spsLen);
          rtmpBody.copy(this.codec.sps, 0, 13, 13 + this.codec.spsLen);
        }
        // pps
        index += this.codec.spsLen;
        var numOfPictureParameterSets = rtmpBody[index];
        numOfPictureParameterSets &= 0x1f;
        if (numOfPictureParameterSets != 1) {
          //console.error("Decode video avc sequenc header pps failed.\n");
          return -1;
        }

        index++;
        this.codec.ppsLen = rtmpBody.readUInt16BE(index);
        index += 2;
        if (this.codec.ppsLen > 0) {
          this.codec.pps = new Buffer(this.codec.ppsLen);
          rtmpBody.copy(this.codec.pps, 0, index, index + this.codec.ppsLen);
        }
        this.isFirstVideoReceived = false;

        //console.info("Parse video avc sequence header success! ");
        // //console.info(this.codec);
        // //console.info('sps: ' + this.codec.sps.hex());
        // //console.info('pps: ' + this.codec.pps.hex());
        //
        //
        this.producer.cacheVideoSequenceBuffer = new Buffer(rtmpBody);
        for (var id in this.consumers) {
          this.consumers[id].startPlay();
        }
      }
    } else if (avc_packet_type == 1) {
      var sendRtmpHeader = {
        chunkStreamID: 4,
        timestamp: rtmpHeader.timestamp,
        messageTypeID: 0x09,
        messageStreamID: 1,
      };
      var rtmpMessage = this.createRtmpMessage(sendRtmpHeader, rtmpBody);

      for (var id in this.consumers) {
        this.consumers[id].sendBufferQueue.push(rtmpMessage);
      }
      /*
            //AVC NALU
            var NALUnitLength = 0;
            if (this.codec.NAL_unit_length == 3) {
                NALUnitLength = rtmpBody.readUInt32BE(5);
            } else if (this.codec.NAL_unit_length == 2) {
                NALUnitLength = ReadUInt24BE(rtmpBody, 5);
            } else if (this.codec.NAL_unit_length == 1) {
                NALUnitLength = rtmpBody.readUInt16BE(5);
            } else {
                NALUnitLength = rtmpBody.readInt8(5);
            }

            var videoBufferLen = 0;
            var videoBuffer = null;
            if (frame_type == 1) {
                videoBufferLen = 4 + this.codec.spsLen + 4 + this.codec.ppsLen + 4 + NALUnitLength;
                videoBuffer = new Buffer(videoBufferLen);
                NAL_HEADER.copy(videoBuffer);
                this.codec.sps.copy(videoBuffer, 4);
                NAL_HEADER.copy(videoBuffer, 4 + this.codec.spsLen);
                this.codec.pps.copy(videoBuffer, 4 + this.codec.spsLen + 4);
                NAL_HEADER.copy(videoBuffer, 4 + this.codec.spsLen + 4 + this.codec.ppsLen);
                rtmpBody.copy(videoBuffer, 4 + this.codec.spsLen + 4 + this.codec.ppsLen + 4, 9, NALUnitLength);
            } else {
                NAL_HEADER.copy(videoBuffer);
                rtmpBody.copy(videoBuffer, 4, 9, NALUnitLength);
            }
            return videoBuffer;
            */
    } else {
      //AVC end of sequence (lower level NALU sequence ender is not required or supported)
    }
  };

  NMRtmpConn.prototype.sendStreamEOF = function () {
    var rtmpBuffer = new Buffer("020000000000060400000000000100000001", "hex");
    this.socket.write(rtmpBuffer);
  };

  NMRtmpConn.prototype.sendRtmpMessage = function (self) {
    if (!self.isStarting) return;
    var len = self.sendBufferQueue.length;
    for (var i = 0; i < len; i++) {
      self.socket.write(self.sendBufferQueue.shift());
    }
    setTimeout(self.sendRtmpMessage, 100, self);
  };
}

module.exports = NMRtmpConn;
