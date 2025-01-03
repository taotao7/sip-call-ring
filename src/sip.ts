import md5 from "blueimp-md5";
import { ofetch, $Fetch } from "ofetch";

// 坐席用
class SipSocket {
  apiServer: $Fetch;
  client: WebSocket;
  loginStatus: boolean = false;
  exitStatus: boolean = false;
  loginInfo: {
    username: string;
    password: string;
  };
  auth: {
    token: string;
    refreshToken: string;
    expireAt: number;
  } = {
    token: "",
    refreshToken: "",
    expireAt: 0,
  };
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    protocol: boolean,
    host: string,
    port: string,
    username: string,
    password: string,
    kick: () => void, // 接受kick操作
    statusListener: (v: number) => void, // 接受状态
    callbackInfo: (v: any) => void, // 接受callback info
    groupCallNotify: (v: any) => void // 接受groupCallNotify
  ) {
    const baseUrl =
      (protocol ? "wss" : "ws") + "://" + host + ":" + port + "/api/sdk/ws";
    const apiServer =
      (protocol ? "https" : "http") + "://" + host + ":" + port + "/api/sdk";
    this.loginInfo = {
      username,
      password,
    };
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
    this.listen(kick, statusListener, callbackInfo, groupCallNotify);
  }

  public listen(
    kick: () => void,
    statusListener: (v: number) => void,
    callbackInfo: (v: any) => void,
    groupCallNotify: (v: any) => void
  ) {
    this.client.onopen = () => {
      this.login();
    };
    this.client.onmessage = (event: any) => {
      const res = JSON.parse(event.data);

      if (res?.code === 0 && res?.data && res?.data?.token) {
        this.auth.token = res.data.token;
        this.auth.refreshToken = res.data.refreshToken;
        this.auth.expireAt = res.data.expireAt;
        this.loginStatus = true;
      }

      // 接受服务端的状态
      if (res?.code === 0 && res?.data?.action === "status") {
        statusListener(res.data.status);
      }

      // 接受callback info
      if (res?.code === 0 && res?.data?.action === "numberInfo") {
        callbackInfo({
          extraInfo: res.data.extraInfo,
          number: res.data.number,
        });
      }

      if (res?.code === 0 && res?.data?.action === "ping") {
        this.client.send(
          JSON.stringify({ action: "pong", actionId: res?.data?.actionId })
        );
      }

      // kick 被踢出就关闭连接
      if (res?.code === 0 && res?.data?.action === "kick") {
        this.loginStatus = false;
        this.client.close();
        this.auth.token = "";
        kick();
      }

      // 接受groupCallNotify
      if (res?.code === 0 && res.data.action === "groupCallNotify") {
        groupCallNotify({
          ...res.data.data,
          type: res.data.type,
        });
      }
    };

    // 当sock断开时
    this.client.onclose = () => {
      this.loginStatus = false;
      this.auth.token = "";
      this.clearHeartbeat();
      if (!this.exitStatus) kick();
    };
  }

  // 没2两秒检测一次登录状态
  public checkLogin() {
    return new Promise<any>((resolve, reject) => {
      let start = 0;
      const timer = setInterval(async () => {
        start += 2000;
        if (this.loginStatus) {
          try {
            const res = await this.getSipWebrtcAddr();
            clearInterval(timer);
            const params = {
              ...this.auth,
              ...res.data,
            };
            resolve(params);
          } catch (e) {
            reject(e);
            clearInterval(timer);
          }
        }
        if (start > 10000) {
          reject("login timeout");
          clearInterval(timer);
        }
      }, 2000);
    });
  }

  public login() {
    const timestamp = new Date().getTime();
    const nonce = Math.random().toString(32).substr(2);
    const { username, password } = this.loginInfo;
    this.client.send(
      JSON.stringify({
        action: "login",
        actionId: "",
        params: {
          username,
          timestamp,
          password: md5(timestamp + password + nonce),
          nonce,
        },
      })
    );
    this.heartBeat();
  }

  public heartBeat() {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify({ action: "ping" }));
      this.heartbeatTimer = setTimeout(() => {
        this.heartBeat();
      }, 2000);
    }
  }

  // 在需要停止心跳的地方（如logout或连接关闭时）清除定时器
  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public logout() {
    this.exitStatus = true;
    this.auth.token = "";
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify({ action: "logout", actionId: "" }));
    }
    this.clearHeartbeat();
  }

  private async getSipWebrtcAddr() {
    return this.apiServer("/webrtc/addr", {
      method: "GET",
      parseResponse: JSON.parse,
    });
  }

  public onDialing() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: 5,
      },
    });
  }

  public onResting() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: 6,
      },
    });
  }

  public onIdle() {
    return this.apiServer("/agent/status/switch", {
      method: "POST",
      body: {
        action: 2,
      },
    });
  }

  public transfer(num: string) {
    return this.apiServer("/call/transfer", {
      method: "POST",
      body: {
        transferTo: num,
      },
    });
  }

  public async refreshToken() {
    const res = await this.apiServer("/token/refresh", {
      method: "POST",
      body: {
        refreshToken: this.auth.refreshToken,
      },
      parseResponse: JSON.parse,
    });

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
