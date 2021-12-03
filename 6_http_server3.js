const net = require("net");

function Server() {
    net.Server.call(this)
}

const s = new Server();

console.log(Server.prototype)