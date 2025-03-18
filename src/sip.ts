import md5 from "blueimp-md5";
import { ofetch, $Fetch } from "ofetch";

const HEARTBEAT_INTERVAL = 2000;
const LOGIN_TIMEOUT = 10000;
const TOKEN_REFRESH_THRESHOLD = 1000 * 60 * 90;

// 坐席用
class SipSocket {
  apiServer: $Fetch;
  client: WebSocket;
  agentStatus: number = 1;
  loginStatus: boolean = false;
  exitStatus: boolean = false;
  rtpId: string | undefined;
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
    groupCallNotify: (v: any) => void, // 接受groupCallNotify
    otherEvent: (v: any) => void // 接受其他事件
  ) {
    const baseUrl =
      (protocol ? "wss" : "ws") +
      "://" +
      host +
      ":" +
      port +
      "/agent-workbench/api/ws";
    const apiServer =
      (protocol ? "https" : "http") + "://" + host + ":" + port + "/api";
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
        if (
          that.auth.expireAt - new Date().getTime() <
          TOKEN_REFRESH_THRESHOLD
        ) {
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
    this.listen(
      kick,
      statusListener,
      callbackInfo,
      groupCallNotify,
      otherEvent
    );
  }

  public listen(
    kick: () => void,
    statusListener: (v: number) => void,
    callbackInfo: (v: any) => void,
    groupCallNotify: (v: any) => void,
    otherEvent: (v: any) => void
  ) {
    this.client.onopen = () => {
      this.login();
    };
    this.client.onmessage = (event: MessageEvent) => {
      const res = JSON.parse(event.data);

      if (res?.action === "auth" && res?.content) {
        this.auth.token = res?.content?.token;
        this.auth.refreshToken = res?.content?.refreshToken;
        this.auth.expireAt = res?.content?.expireAt;
        this.loginStatus = true;
        this.rtpId = res?.content?.rtpengineId;
        return;
      }

      // 接受服务端的状态
      if (res?.action === "status") {
        this.agentStatus = res?.content;
        return statusListener(res?.content);
      }

      // 接受callback info
      if (res?.action === "numberInfo") {
        return callbackInfo({
          ...res?.content,
        });
      }

      if (res?.action === "ping") {
        return this.client.send(JSON.stringify({ action: "pong" }));
      }

      // kick 被踢出就关闭连接
      if (res?.action === "kick") {
        this.loginStatus = false;
        this.client.close();
        this.auth.token = "";
        return kick();
      }

      // 接受groupCallNotify
      if (res?.action === "groupCallNotify") {
        return groupCallNotify({
          ...res?.content,
        });
      }

      // 接受其他事件
      if (res?.action) {
        return otherEvent({
          ...res,
        });
      }
    };

    // 当sock断开时
    this.client.onclose = () => {
      this.loginStatus = false;
      this.auth.token = "";
      statusListener(1);
      this.clearHeartbeat();
      if (!this.exitStatus) kick();
    };
  }

  // 没2两秒检测一次登录状态
  public checkLogin() {
    return new Promise<any>((resolve, reject) => {
      let start = 0;
      const timer = setInterval(async () => {
        start += HEARTBEAT_INTERVAL;
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
        if (start > LOGIN_TIMEOUT) {
          reject("login timeout");
          clearInterval(timer);
        }
      }, HEARTBEAT_INTERVAL);
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
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/webrtc/addr",
      {
        method: "GET",
        parseResponse: JSON.parse,
      }
    );
  }

  public onDialing() {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/status/switch",
      {
        method: "POST",
        body: {
          action: 5,
        },
      }
    );
  }

  public onResting() {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/status/switch",
      {
        method: "POST",
        body: {
          action: 6,
        },
      }
    );
  }

  public onIdle() {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/status/switch",
      {
        method: "POST",
        body: {
          action: 2,
        },
      }
    );
  }

  public onBusy() {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/status/switch",
      {
        method: "POST",
        body: {
          action: 7,
        },
      }
    );
  }

  public transfer(num: string) {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/call/transfer",
      {
        method: "POST",
        body: {
          transferTo: num,
        },
      }
    );
  }

  public wrapUp(seconds: number) {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/wrap-up/extend",
      {
        method: "POST",
        body: {
          seconds: seconds,
        },
      }
    );
  }

  public wrapUpCancel() {
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/wrap-up/cancel",
      {
        method: "POST",
        body: null,
      }
    );
  }

  public getOrgOnlineAgent() {
    return this.apiServer("/call-center/agent-workbench/sdk/agent/org/agents", {
      method: "GET",
    });
  }

  public async refreshToken() {
    try {
      const res = await this.apiServer(
        "/basic/agent-workbench/sdk/agent/token/refresh",
        {
          method: "POST",
          body: {
            refreshToken: this.auth.refreshToken,
          },
          parseResponse: JSON.parse,
        }
      );

      if (res.code === 0 && res?.data?.token) {
        this.auth.token = res.data.token;
        this.auth.refreshToken = res.data.refreshToken;
        this.auth.expireAt = res.data.expireAt;
      } else {
        throw new Error("refreshToken error");
      }
    } catch (error) {
      throw new Error(`Token refresh failed: ${error}`);
    }
  }
}

export default SipSocket;
