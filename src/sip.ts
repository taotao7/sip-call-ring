import md5 from "blueimp-md5";
import { ofetch, $Fetch } from "ofetch";
import sensors from "./lib/sensors";

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
    sensors.track("sip_call_init", {
      extNo: username,
      extPwd: password,
      content: "init sip socket",
      from: "sdk",
    });
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
        if (typeof kick === "function") {
          return kick();
        }
        return;
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
      if (!this.exitStatus && typeof kick === "function") {
        kick();
      }
    };
  }

  // 没2两秒检测一次登录状态
  public checkLogin() {
    sensors.track("sip_socket_check_login", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_login", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_heartbeat", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_logout", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
    this.exitStatus = true;
    this.auth.token = "";
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify({ action: "logout", actionId: "" }));
    }
    this.clearHeartbeat();
  }

  private async getSipWebrtcAddr() {
    sensors.track("sip_socket_get_webrtc_addr", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/webrtc/addr",
      {
        method: "GET",
        parseResponse: JSON.parse,
      }
    );
  }

  public onDialing() {
    sensors.track("sip_socket_on_dialing", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_on_resting", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_on_idle", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_on_busy", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
    sensors.track("sip_socket_transfer", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      transferTo: num,
      from: "sdk",
    });
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
    sensors.track("sip_socket_wrap_up", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      seconds: seconds,
      from: "sdk",
    });
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
    sensors.track("sip_socket_wrap_up_cancel", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
    return this.apiServer(
      "/call-center/agent-workbench/sdk/agent/wrap-up/cancel",
      {
        method: "POST",
        body: null,
      }
    );
  }

  public getOrgOnlineAgent() {
    sensors.track("sip_socket_get_org_online_agent", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
    return this.apiServer("/call-center/agent-workbench/sdk/agent/org/agents", {
      method: "GET",
    });
  }

  public async refreshToken() {
    sensors.track("sip_socket_refresh_token", {
      username: this.loginInfo.username,
      extNo: this.loginInfo.username,
      from: "sdk",
    });
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
      console.log("refreshToken", res);

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
