const http = require("http");
const fs = require("fs");
const path = require("path");
const { format } = require("util");

const resolve = (p) => path.resolve(__dirname, p);
const m3u8Template = fs.readFileSync(resolve("./source/play.m3u8"), { encoding: "utf-8" });
const fileDuration = m3u8Template.match(/#EXTINF:([\d\.]+),\s*\n(live_[\d]+\.ts)/g).map((v, i) => {
  const [duration, fileName] = v.split(/[,\r\n]+/);
  return {
    duration: +duration.replace("#EXTINF:", ""),
    tag: v,
    fileName,
    index: i,
  };
});
const playListNum = 3;

// 总秒数
const totalDuration = fileDuration.reduce((a, b) => {
  if (typeof a === "number") {
    return a + b.duration;
  }
  return a.duration + b.duration;
});

// 模拟主播开播时间
const startTime = Date.now() - 1000 * 110;

// 模板头
const template = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:%d
#EXT-X-TARGETDURATION:9
`;

function findTag(delta) {
  let summaryDur = 0;
  for (let i of fileDuration) {
    summaryDur += i.duration;
    if (delta <= summaryDur) {
      return i;
    }
  }

  return fileDuration[0];
}

function processTag(i, seq) {
  let num = seq + i;
  num = num < 100 ? (num < 10 ? "00" + num : "0" + num) : num;
  let j = i;
  if (j >= fileDuration.length) {
    j = j % fileDuration.length;
  } else if (j < 0) {
    j = fileDuration.length - 1
  }
  console.log(j, num);
  const tag = fileDuration[j];
  return `#EXTINF:${tag.duration},
live_${num}.ts`;
}

// 渲染完整模板
function renderXml() {
  let xml = template;
  const delta = (Date.now() - startTime) / 1000; // 时间差
  const loops = Math.floor(delta / totalDuration); // 循环次数
  let deltaInLoop = delta - totalDuration * loops; // 相对循环时间差
  let sequenceInLoop = loops * fileDuration.length; // 下标
  let tags = [];
  const tag = findTag(deltaInLoop);
  const tagIdx = tag.index;
  const sq = (playListNum - 1) / 2;

  for (let i = tagIdx - sq; i <= tagIdx + sq; i++) {
    if (i < 0 && loops === 0) {
      continue;
    }
    tags.push(processTag(i, sequenceInLoop));
  }

  if (tags.length < playListNum) {
    tags.push(processTag(playListNum - 1, sequenceInLoop));
  }

  xml = format(xml, sequenceInLoop + tagIdx);
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
  } else if (isTs) {
    let str = url.split("?t=")[0];
    const num = +str.replace("/live_", "").replace(".ts", "");
    const tagIdx = num % fileDuration.length;
    str = "/live_" + (tagIdx < 100 ? (tagIdx < 10 ? "00" + tagIdx : "0" + tagIdx) : tagIdx) + ".ts";
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
  //   const xml = renderXml();
  //   // console.log(xml);
  // }, 1000);
});
