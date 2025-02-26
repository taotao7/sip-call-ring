import md5 from "blueimp-md5";
import { ofetch, $Fetch } from "ofetch";

const HEARTBEAT_INTERVAL = 2000;
const LOGIN_TIMEOUT = 10000;
const TOKEN_REFRESH_THRESHOLD = 1000 * 60 * 90;
const RECONNECT_INTERVAL = 5000; // 重连间隔时间，5秒
const MAX_RECONNECT_ATTEMPTS = 5; // 最大重连次数

// 坐席用
class SipSocket {
  apiServer: $Fetch;
  client: WebSocket | null = null;
  agentStatus: number = 1;
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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private baseUrl: string;
  private apiServerUrl: string;
  private kickCallback: () => void;
  private statusListenerCallback: (v: number) => void;
  private callbackInfoCallback: (v: any) => void;
  private groupCallNotifyCallback: (v: any) => void;
  private otherEventCallback: (v: any) => void;
  private checkLoginTimer: NodeJS.Timeout | null = null; // 添加登录检查定时器引用

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
    this.baseUrl =
      (protocol ? "wss" : "ws") +
      "://" +
      host +
      ":" +
      port +
      "/agent-workbench/api/ws";
    this.apiServerUrl =
      (protocol ? "https" : "http") + "://" + host + ":" + port + "/api";
    this.loginInfo = {
      username,
      password,
    };

    // 保存回调函数，以便在重连时使用
    this.kickCallback = kick;
    this.statusListenerCallback = statusListener;
    this.callbackInfoCallback = callbackInfo;
    this.groupCallNotifyCallback = groupCallNotify;
    this.otherEventCallback = otherEvent;

    // 初始化WebSocket连接
    this.initWebSocket();

    const that = this;
    this.apiServer = ofetch.create({
      baseURL: this.apiServerUrl,
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
  }

  // 初始化WebSocket连接
  private initWebSocket() {
    try {
      this.client = new WebSocket(this.baseUrl);
      this.listen(
        this.kickCallback,
        this.statusListenerCallback,
        this.callbackInfoCallback,
        this.groupCallNotifyCallback,
        this.otherEventCallback
      );
    } catch (error) {
      console.error("WebSocket初始化失败:", error);
      // 如果初始化失败且不是主动退出，尝试重连
      if (!this.exitStatus) {
        this.attemptReconnect();
      }
    }
  }

  public listen(
    kick: () => void,
    statusListener: (v: number) => void,
    callbackInfo: (v: any) => void,
    groupCallNotify: (v: any) => void,
    otherEvent: (v: any) => void
  ) {
    if (!this.client) {
      console.error("WebSocket客户端未初始化");
      return;
    }

    this.client.onopen = () => {
      console.log("WebSocket连接已建立");
      // 连接成功，重置重连计数
      this.reconnectAttempts = 0;
      this.login();
    };

    this.client.onmessage = (event: MessageEvent) => {
      if (!this.client) return;

      const res = JSON.parse(event.data);

      if (res?.action === "auth" && res?.content) {
        this.auth.token = res?.content?.token;
        this.auth.refreshToken = res?.content?.refreshToken;
        this.auth.expireAt = res?.content?.expireAt;
        this.loginStatus = true;
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
        if (this.client && this.client.readyState === WebSocket.OPEN) {
          return this.client.send(JSON.stringify({ action: "pong" }));
        }
      }

      // kick 被踢出就关闭连接
      if (res?.action === "kick") {
        this.loginStatus = false;
        if (this.client) {
          this.client.close();
        }
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
    this.client.onclose = (event) => {
      console.log(
        `WebSocket连接已断开，关闭代码: ${event.code}, 原因: ${event.reason}`
      );
      this.loginStatus = false;
      this.auth.token = "";
      this.clearHeartbeat();
      this.clearCheckLoginTimer(); // 清除登录检查定时器

      // 如果不是主动退出，尝试重连
      if (!this.exitStatus) {
        console.log("WebSocket连接已断开，准备重连...");
        this.attemptReconnect();
      } else {
        console.log("WebSocket连接已主动关闭，不进行重连");
        this.kickCallback();
      }
    };

    // 处理连接错误
    this.client.onerror = (error) => {
      console.error("WebSocket连接错误:", error);
      // 不要抛出错误，让onclose处理重连
      // 移除 throw error;
    };
  }

  // 尝试重新连接
  private attemptReconnect() {
    // 清除之前的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 如果已经达到最大重试次数，则不再重试
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log(`已达到最大重连次数(${MAX_RECONNECT_ATTEMPTS})，停止重连`);
      this.reconnectAttempts = 0; // 重置重连计数，以便下次可以重新尝试
      this.kickCallback(); // 通知上层连接已断开
      return;
    }

    // 增加重试计数
    this.reconnectAttempts++;

    console.log(
      `尝试第 ${this.reconnectAttempts} 次重连，将在 ${RECONNECT_INTERVAL / 1000} 秒后重连...`
    );

    // 设置定时器进行重连
    this.reconnectTimer = setTimeout(() => {
      console.log(`正在进行第 ${this.reconnectAttempts} 次重连...`);

      // 确保在重连前关闭现有连接
      if (this.client && this.client.readyState !== WebSocket.CLOSED) {
        try {
          this.client.close();
        } catch (e) {
          console.error("关闭WebSocket连接失败:", e);
        }
      }

      // 重置状态但不设置 exitStatus 为 true
      this.loginStatus = false;
      this.auth.token = "";
      this.clearHeartbeat();
      this.clearCheckLoginTimer();

      // 重新初始化 WebSocket
      this.initWebSocket();
    }, RECONNECT_INTERVAL);
  }

  // 清除登录检查定时器
  private clearCheckLoginTimer() {
    if (this.checkLoginTimer) {
      clearInterval(this.checkLoginTimer);
      this.checkLoginTimer = null;
    }
  }

  // 没2两秒检测一次登录状态
  public checkLogin() {
    return new Promise<any>((resolve, reject) => {
      let start = 0;
      this.clearCheckLoginTimer(); // 确保之前的定时器被清除

      this.checkLoginTimer = setInterval(async () => {
        start += HEARTBEAT_INTERVAL;

        // 如果已经主动退出，则停止检查
        if (this.exitStatus) {
          this.clearCheckLoginTimer();
          reject("用户已主动退出");
          return;
        }

        if (this.loginStatus) {
          try {
            const res = await this.getSipWebrtcAddr();
            this.clearCheckLoginTimer();
            const params = {
              ...this.auth,
              ...res.data,
            };
            resolve(params);
          } catch (e) {
            console.error("获取SIP地址失败:", e);
            this.clearCheckLoginTimer();

            // 如果不是主动退出，尝试重连而不是直接拒绝
            if (!this.exitStatus) {
              console.log("获取SIP地址失败，尝试重连...");
              this.attemptReconnect();
            }
            reject(e);
          }
        }

        if (start > LOGIN_TIMEOUT) {
          console.log(`登录超时(${LOGIN_TIMEOUT}ms)，检查连接状态`);
          this.clearCheckLoginTimer();

          // 登录超时不应该直接调用 logout，而是尝试重连
          if (!this.exitStatus) {
            console.log("登录超时，尝试重连...");
            this.attemptReconnect();
          }
          reject("login timeout");
        }
      }, HEARTBEAT_INTERVAL);
    });
  }

  public login() {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      console.error("WebSocket未连接，无法登录");
      if (!this.exitStatus) {
        this.attemptReconnect();
      }
      return;
    }

    const timestamp = new Date().getTime();
    const nonce = Math.random().toString(32).substr(2);
    const { username, password } = this.loginInfo;

    try {
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
    } catch (error) {
      console.error("发送登录请求失败:", error);
      if (!this.exitStatus) {
        this.attemptReconnect();
      }
    }
  }

  public heartBeat() {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      try {
        this.client.send(JSON.stringify({ action: "ping" }));
        this.heartbeatTimer = setTimeout(() => {
          this.heartBeat();
        }, 2000);
      } catch (error) {
        console.error("发送心跳失败:", error);
        this.clearHeartbeat();

        // 如果心跳失败且不是主动退出，尝试重连
        if (!this.exitStatus) {
          this.attemptReconnect();
        }
      }
    } else {
      this.clearHeartbeat();

      // 如果WebSocket未连接且不是主动退出，尝试重连
      if (
        !this.exitStatus &&
        (!this.client || this.client.readyState !== WebSocket.CONNECTING)
      ) {
        console.log("心跳检测到WebSocket未连接，尝试重连...");
        this.attemptReconnect();
      }
    }
  }

  // 在需要停止心跳的地方（如logout或连接关闭时）清除定时器
  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // 清除重连定时器
  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 手动重连函数，可以在外部调用触发重连
   * @param resetAttempts 是否重置重连尝试次数，默认为true
   * @returns 返回一个Promise，重连成功时resolve，失败时reject
   */
  public reconnect(resetAttempts: boolean = true): Promise<boolean> {
    console.log("手动触发重连...");

    // 重置退出状态，确保可以重连
    this.exitStatus = false;

    // 可选择是否重置重连尝试次数
    if (resetAttempts) {
      this.reconnectAttempts = 0;
    }

    // 清理现有连接和定时器
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.clearCheckLoginTimer();

    // 关闭现有WebSocket连接
    if (this.client && this.client.readyState !== WebSocket.CLOSED) {
      try {
        this.client.close();
      } catch (error) {
        console.error("关闭现有WebSocket连接失败:", error);
      }
    }

    // 重置状态
    this.loginStatus = false;
    this.auth.token = "";
    this.agentStatus = 1;

    // 创建一个Promise来跟踪重连结果
    return new Promise((resolve, reject) => {
      // 立即初始化新的WebSocket连接
      this.initWebSocket();

      // 设置一个超时检查，等待连接和登录完成
      const checkConnected = setInterval(() => {
        // 如果已登录，则重连成功
        if (this.loginStatus) {
          clearInterval(checkConnected);
          console.log("手动重连成功");
          resolve(true);
        }

        // 如果重连尝试次数超过最大值，则重连失败
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          clearInterval(checkConnected);
          console.log("手动重连失败，已达到最大重试次数");
          reject(new Error("重连失败，已达到最大重试次数"));
        }
      }, 1000); // 每秒检查一次

      // 设置总超时，避免无限等待
      setTimeout(() => {
        if (!this.loginStatus) {
          clearInterval(checkConnected);
          console.log("手动重连超时");
          reject(new Error("重连超时"));
        }
      }, LOGIN_TIMEOUT * 2); // 使用两倍的登录超时时间作为总超时
    });
  }

  public logout() {
    console.log("执行主动登出操作");
    this.exitStatus = true;
    this.auth.token = "";
    this.reconnectAttempts = 0; // 重置重连计数

    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.clearCheckLoginTimer();

    if (this.client && this.client.readyState === WebSocket.OPEN) {
      try {
        this.client.send(JSON.stringify({ action: "logout", actionId: "" }));
      } catch (error) {
        console.error("发送登出请求失败:", error);
      }
    }

    // 确保连接关闭
    if (this.client && this.client.readyState !== WebSocket.CLOSED) {
      try {
        this.client.close();
      } catch (error) {
        console.error("关闭WebSocket连接失败:", error);
      }
    }

    // 确保回调被调用
    setTimeout(() => {
      if (this.kickCallback) {
        this.kickCallback();
      }
    }, 100);
  }

  private async getSipWebrtcAddr() {
    try {
      return await this.apiServer(
        "/call-center/agent-workbench/sdk/agent/webrtc/addr",
        {
          method: "GET",
          parseResponse: JSON.parse,
        }
      );
    } catch (error) {
      console.error("获取SIP地址失败:", error);
      // 如果不是主动退出，尝试重连
      if (!this.exitStatus) {
        this.attemptReconnect();
      }
      throw error;
    }
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
      console.error("刷新Token失败:", error);
      // 如果不是主动退出，尝试重连
      if (!this.exitStatus) {
        this.attemptReconnect();
      }
      throw new Error(`Token refresh failed: ${error}`);
    }
  }
}

export default SipSocket;
