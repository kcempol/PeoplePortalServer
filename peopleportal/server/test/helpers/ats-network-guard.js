// Focused ATS tests must fail immediately if a dependency tries external I/O.
const forbidden = () => { throw new Error("External network access forbidden in ATS unit tests"); };
global.fetch = forbidden;
require("node:net").Socket.prototype.connect = forbidden;
require("node:tls").connect = forbidden;
require("node:http").request = forbidden;
require("node:https").request = forbidden;
