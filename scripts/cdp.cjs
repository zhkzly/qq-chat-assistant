'use strict';
class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data); const task = this.pending.get(message.id);
      if (!task) return; this.pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    };
    socket.onclose = () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP closed')); } };
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    return new CDP(socket);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}
module.exports = { CDP };
