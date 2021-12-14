const fs = require("fs");
const path = require("path");

const logPath = path.resolve(__dirname, "./rtmp.log");
const ws = fs.createWriteStream(logPath, { encoding: "utf-8" });

function log() {
  console.log(...arguments);
  ws.write([...arguments].join(" ").toString() + "\n");
}

module.exports = {
  log,
};
