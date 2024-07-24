import md5 from "blueimp-md5";
import { ofetch, $Fetch } from "ofetch";

// 坐席用
class SipSocket {
  apiServer: $Fetch;
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
    protocol: boolean,
    host: string,
    port: string,
    username: string,
    password: string
  ) {
    const baseUrl =
      (protocol ? "wss" : "ws") + "://" + host + ":" + port + "/api/sdk/ws";
    const apiServer =
      (protocol ? "https" : "http") + "://" + host + ":" + port + "/api/sdk";
    this.client = new WebSocket(baseUrl);
    const that = this;
    this.apiServer = ofetch.create({
      baseURL: apiServer,
      headers: {
        "Content-Type": "application/json",
      },
      onRequest(context) {
        // 检查token是否需要刷新
        if (that.auth.expireAt - new Date().getTime() < 1000 * 60 * 90) {
          that.refreshToken();
        }
        if (that.auth.token) {
          context.options.headers = {
            ...context.options.headers,
            "x-api-key": that.auth.token,
          };
        }
      },
    });
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

  public onDialing() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: "dialing",
      },
    });
  }

  public onResting() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: "resting",
      },
    });
  }

  public onIdle() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: "idle",
      },
    });
  }

  public async refreshToken() {
    const res = await this.apiServer("/token/refresh", {
      method: "POST",
      body: {
        action: "refreshToken",
        params: {
          refreshToken: this.auth.refreshToken,
        },
      },
      parseResponse: JSON.parse,
    });

    // TODO 测试接口数据是否返回一致
    if (res.code === 0 && res?.data?.token) {
      this.auth.token = res.data.token;
      this.auth.refreshToken = res.data.refreshToken;
      this.auth.expireAt = res.data.expireAt;
    } else {
      throw new Error("refreshToken error");
    }
  }
}

export default SipSocket;
