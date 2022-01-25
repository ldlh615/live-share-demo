const http = require("http");
const fs = require("fs");
const path = require("path");
const { format } = require("util");

const resolve = (p) => path.resolve(__dirname, p);
const m3u8Template = fs.readFileSync(resolve("./source/play.m3u8"), { encoding: "utf-8" });
const fileDuration = m3u8Template.match(/#EXTINF:([\d\.]+),\s*\n(live_[\d]+\.ts)/g).map((v) => {
  const [duration] = v.split(/[,\r\n]+/);
  return {
    duration: +duration.replace("#EXTINF:", ""),
    tag: v,
  };
});
const playListNum = 10;

// 总秒数
const totalDuration = fileDuration.reduce((a, b) => {
  if (typeof a === "number") {
    return a + b.duration;
  }
  return a.duration + b.duration;
});

// 模拟主播开播时间
const startTime = Date.now() - 1000 * 0;

// 模板头
const template = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:%d
#EXT-X-TARGETDURATION:9
`;

// 渲染完整模板
function renderXml() {
  let xml = template;
  const delta = (Date.now() - startTime) / 1000; // 时间差
  const loops = Math.floor(delta / totalDuration); // 循环次数
  let deltaInLoop = delta - totalDuration * loops; // 相对循环时间差
  let sequenceInLoop = loops * fileDuration.length; // 下标
  let tags = [];

  for (let i = 0; i < fileDuration.length; i++) {
    const o = fileDuration[i];
    deltaInLoop -= o.duration;
    if (deltaInLoop > 0) {
      sequenceInLoop += 1;
    } else if (tags.length < playListNum) {
      tags.push(o.tag);
    } else {
      break;
    }
  }

  if (tags.length < playListNum) {
    tags = tags.concat(fileDuration.slice(0, playListNum - tags.length).map((v) => v.tag));
  }

  // console.log(fileDuration);
  // console.log(totalDuration);
  // console.log(tags);
  // console.log(totalDuration, delta, loops, loopSequence, deltaInLoop);

  xml = format(xml, sequenceInLoop);
  xml += tags.join("\n");
  return xml;
}

const server = http.createServer((req, res) => {
  const url = req.url;
  console.log("request come: ", url);
  const isM3u8 = url.indexOf(".m3u8") > -1;
  const isTs = url.indexOf(".ts") > -1;

  if (isM3u8) {
    const m3u8Xml = renderXml();
    const contentBuf = Buffer.from(m3u8Xml);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", contentBuf.length);
    res.setHeader("Content-Range", `bytes ${contentBuf.length - 1}/${contentBuf.length}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,request-origin");
    res.writeHead(200);
    res.write(m3u8Xml);
    res.end();
    console.log(m3u8Xml);
  } else if (isTs) {
    const str = url.split("?t=")[0];
    const filePath = resolve("./source/" + str);
    res.setHeader("Content-Type", "video/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,request-origin");
    const rs = fs.createReadStream(filePath);
    rs.pipe(res);
  } else {
    res.end("ok");
  }
});

server.listen(1234, "0.0.0.0", () => {
  console.log("http://127.0.0.1:1234/live.m3u8");

  // setInterval(() => {
  //   renderXml();
  // }, 1000);
  // renderXml();
});
