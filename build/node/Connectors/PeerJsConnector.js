(function(){var n;n=function(){var n,e,t;return t=null,2===arguments.length?(t=new Peer(arguments[0]),e=arguments[1]):(t=new Peer(arguments[0],arguments[1]),e=arguments[2]),n=function(){function n(n,e,o,r){var i;this.engine=n,this.HB=e,this.execution_listener=o,this.yatta=r,this.peer=t,this.connections={},this.peer.on("connection",function(n){return function(e){return e.send("hey"),n.addConnection(e)}}(this)),i=function(n){return function(e){return n.send(e)}}(this),this.execution_listener.push(i)}return n.prototype.connectToPeer=function(n){return null==this.connections[n]&&n!==this.yatta.getUserId()?this.addConnection(t.connect(n)):void 0},n.prototype.getAllConnectionIds=function(){var n,e;e=[];for(n in this.connections)e.push(n);return e},n.prototype.addConnection=function(n){var e;return this.connections[n.peer]=n,n.on("data",function(n){return function(e){var t,o,r,i,u;if("hey"===e)return console.log("Yatta: Connection received with init message (debug)");if(null!=e.HB)return n.engine.applyOpsCheckDouble(e.HB);if(null!=e.op)return n.engine.applyOp(e.op);if(null!=e.conns){for(i=e.conns,u=[],o=0,r=i.length;r>o;o++)t=i[o],u.push(n.connectToPeer(t));return u}throw new Error("Can't parse this operation")}}(this)),e=function(e){return function(){return n.send({HB:e.yatta.getHistoryBuffer()._encode()}),n.send({conns:e.getAllConnectionIds()})}}(this),setTimeout(e,1e3)},n.prototype.send=function(n){var e,t,o,r;if(n.uid.creator===this.HB.getUserId()&&"string"!=typeof n.uid.op_number){o=this.connections,r=[];for(t in o)e=o[t],r.push(e.send({op:n}));return r}},n.prototype.receive=function(n){return n.uid.creator!==this.HB.getUserId()?this.engine.applyOp(n):void 0},n}(),t.on("open",function(t){return e(n,t)})},module.exports=n,"undefined"!=typeof window&&null!==window&&(null==window.Y&&(window.Y={}),window.Y.createPeerJsConnector=n)}).call(this);
//# sourceMappingURL=../Connectors/PeerJsConnector.js.map