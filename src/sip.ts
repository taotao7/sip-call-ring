import md5 from "blueimp-md5";
// 坐席用
class SipSocket {
  baseUrl: string;
  client: WebSocket;
  status: string | undefined;
  auth: {
    token: string;
    refreshToken: string;
    expireAt: number;
  } = {
    token: "",
    refreshToken: "",
    expireAt: 0,
  };

  constructor(
    protocol: string,
    host: string,
    port: string,
    username: string,
    password: string
  ) {
    this.baseUrl = protocol + "://" + host + ":" + port + "/api/sdk/ws";
    this.client = new WebSocket(this.baseUrl);
    this.listen();
    this.login(username, password);
  }

  public listen() {
    this.client.onopen = () => {
      console.log("WebSocket 连接成功");
    };
    this.client.onmessage = (event) => {
      const res = JSON.parse(event.data);
      // 心跳
      if (res.action === "ping") {
        this.client.send(JSON.stringify({ action: "pong" }));
      }

      if (res?.code === 0 && res?.data) {
        this.auth.token = res.data.token;
        this.auth.refreshToken = res.data.refreshToken;
        this.auth.expireAt = res.data;
      }

      // 接受服务端的状态
      if (res?.code === 0 && res?.data?.action === "status") {
        this.status = res.data.status;
      }
    };
  }

  public login(username: string, password: string) {
    const timestamp = new Date().getTime();
    const nonce = Math.random().toString(32).substr(2);
    this.client.send(
      JSON.stringify({
        action: "login",
        params: {
          username,
          timestamp,
          password: md5(timestamp + password + nonce),
          nonce,
        },
      })
    );
  }

  public logout() {
    this.client.send(JSON.stringify({ action: "logout" }));
  }
}

export default SipSocket;
