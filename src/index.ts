import * as jssip from "jssip";
import SipSocket from "./sip";
import { uuidv7 } from "uuidv7";
import {
  HoldEvent,
  IceCandidateEvent,
  IncomingEvent,
  OutgoingEvent,
  PeerConnectionEvent,
  RTCSession,
} from "jssip/lib/RTCSession";
import {
  IncomingMessageEvent,
  IncomingRTCSessionEvent,
  OutgoingMessageEvent,
  OutgoingRTCSessionEvent,
} from "jssip/lib/UA";
import { clearTimeout } from "timers";
import ring from "./ring";
import sensors from "./lib/sensors";

//初始化配置
interface InitConfig {
  host: string;
  port: string;
  domain?: string;
  proto: true;
  extNo: string;
  extPwd: string;
  checkMic: boolean;
  stun?: StunConfig;
  autoRegister: boolean;
  debug?: boolean;
  stateEventListener: Function | undefined;
  statusListener: (status: number) => void;
  callbackInfo: (info: any) => void;
  groupCallNotify: (info: any) => void;
  otherEvent: (info: any) => void;
  kick: () => void;
}

interface StunConfig {
  type: StunType;
  host: string;
  username: string;
  password: string;
}

type StunType = "turn" | "stun";

//呼叫方向:outbound呼出;inbound:呼入
type CallDirection = "outbound" | "inbound";

interface RTCIceServer {
  credential?: string;
  credentialType?: any;
  urls: string | string[];
  username?: string;
}

interface StateListenerMessage {
  msg?: string;
  localAgent?: string;
  direction?: CallDirection; //呼叫方向
  otherLegNumber?: string;
  callId?: string;

  latencyTime?: number | undefined; //网络延迟(ms)
  upLossRate?: number | undefined; //上行-丢包率
  downLossRate?: number | undefined; //下行-丢包率
}

interface NetworkLatencyStat {
  roundTripTime: number | undefined; //延迟时间(ms)

  inboundLost: number | undefined; //下行-丢包数量
  inboundPacketsSent: number | undefined; //下行-包的总数
  inboundAudioLevel: number | undefined; //下行-声音大小

  outboundLost: number | undefined; //上行-丢包数量
  outboundPacketsSent: number | undefined; //上行-包的总数
  outboundAudioLevel: number | undefined; //上行-声音大小
}

interface CallExtraParam {
  outNumber?: string;
  businessId?: string;
}

interface CallEndEvent {
  originator: string; //local,remote
  cause: string;
  code: number;
  answered: boolean;
}

interface LatencyStat {
  latencyTime: number;
  upLossRate: number;
  upAudioLevel: number; //上行-outbound-音量
  downLossRate: number;
  downAudioLevel: number; //下行-inbound-音量
}

const enum State {
  MIC_ERROR = "MIC_ERROR", //麦克风检测异常
  ERROR = "ERROR", //错误操作或非法操作
  CONNECTED = "CONNECTED", //websocket已连接
  DISCONNECTED = "DISCONNECTED", //websocket已断开连接
  REGISTERED = "REGISTERED", //已注册
  UNREGISTERED = "UNREGISTERED", //取消注册
  REGISTER_FAILED = "REGISTER_FAILED", //注册失败
  INCOMING_CALL = "INCOMING_CALL", //呼入振铃
  OUTGOING_CALL = "OUTGOING_CALL", //外呼中
  IN_CALL = "IN_CALL", //通话中
  HOLD = "HOLD", //保持中
  UNHOLD = "UNHOLD",
  CALL_END = "CALL_END", //通话结束
  MUTE = "MUTE", //静音
  UNMUTE = "UNMUTE", //取消静音
  LATENCY_STAT = "LATENCY_STAT", //网络延迟统计
}

export default class SipCall {
  //媒体控制
  private constraints = {
    audio: true,
    video: false,
  };

  //创建audio控件，播放声音的地方
  private audioView = document.createElement("audio");

  private ua!: jssip.UA;
  private socket!: jssip.WebSocketInterface | null;

  //当前坐席号码
  private localAgent: string;
  //呼叫中session:呼出、呼入、当前
  private outgoingSession: RTCSession | undefined;
  private incomingSession: RTCSession | undefined;
  private currentSession: RTCSession | undefined;
  //呼叫方向 outbound:呼出/inbound:呼入
  private direction: CallDirection | undefined;
  //对方号码
  private otherLegNumber: string | undefined;
  //当前通话uuid
  private currentCallId: string | undefined;

  //当前通话的网络延迟统计定时器(每秒钟获取网络情况)
  private currentLatencyStatTimer: NodeJS.Timer | undefined;
  private currentStatReport: NetworkLatencyStat;

  //回调函数
  private stateEventListener: Function | undefined;

  private stunConfig: StunConfig | undefined;
  // websocks client
  private sipSocket: SipSocket | undefined;

  //构造函数-初始化SDK
  constructor(config: InitConfig) {
    //坐席号码
    this.localAgent = config.extNo;

    if (undefined === config.domain || config.domain.length <= 0) {
      config.domain = config.host;
    }
    this.stunConfig = config.stun;

    //注入状态回调函数
    if (config.stateEventListener !== null) {
      this.stateEventListener = config.stateEventListener;
    }
    sensors.track("sip_call_init", {
      extNo: config.extNo,
      content: "init sip controller",
      from: "sdk",
    });

    //麦克风检测开启
    if (config.checkMic) {
      this.micCheck();
    }

    //开始jssip调试模式
    if (config.debug) {
      jssip.debug.enable("JsSIP:*");
    } else {
      jssip.debug.disable();
    }
    //网络情况统计
    this.currentStatReport = {
      outboundPacketsSent: 0,
      outboundLost: 0,
      inboundLost: 0,
      inboundPacketsSent: 0,
      roundTripTime: 0,
      inboundAudioLevel: 0,
      outboundAudioLevel: 0,
    };

    if (config.extNo && config.extPwd) {
      this.sipSocket = new SipSocket(
        config.proto,
        config.host,
        config.port,
        config.extNo,
        config.extPwd,
        //这里监听到action 为kick就断开
        () => {
          try {
            // 先调用用户提供的kick回调
            if (typeof config.kick === "function") {
              config.kick();
            }

            // 确保在sipSocket断开时，SipCall也正确断开
            if (this.ua && this.ua.isConnected()) {
              this.unregister();
            } else {
              this.cleanSDK();
            }
          } catch (err) {
            console.error("处理kick事件出错:", err);
            // 尝试进行基本的清理
            this.cleanSDK();
          }
        },
        config.statusListener,
        config.callbackInfo,
        config.groupCallNotify,
        config.otherEvent
      );
      this.sipSocket
        .checkLogin()
        .then((r) => {
          if (!r.token && !r.host) {
            throw new Error("login failed");
          }
          // JsSIP.C.SESSION_EXPIRES=120,JsSIP.C.MIN_SESSION_EXPIRES=120;
          let proto = r.ssl ? "wss" : "ws";
          let wsServer = proto + "://" + r.host + ":" + r.port;
          this.socket = new jssip.WebSocketInterface(wsServer);

          this.ua = new jssip.UA({
            sockets: [this.socket],
            uri: "sip:" + config.extNo + "@" + r.host,
            password: config.extPwd,
            register: false,
            register_expires: 15,
            session_timers: false,
            // connection_recovery_max_interval:30,
            // connection_recovery_min_interval:4,
            user_agent: "JsSIP 3.9.1",
          });

          //websocket连接成功
          this.ua.on("connected", (e) => {
            this.onChangeState(State.CONNECTED, null);
            //自动注册
            if (config.autoRegister) {
              this.ua.register();
            }
          });
          //websocket连接失败
          this.ua.on("disconnected", (e: any) => {
            this.ua.stop();
            this.socket = null;
            if (e.error) {
              this.onChangeState(State.DISCONNECTED, e.reason);
            }
          });
          //注册成功
          this.ua.on("registered", () => {
            this.onChangeState(State.REGISTERED, {
              localAgent: this.localAgent,
            });
          });
          //取消注册
          this.ua.on("unregistered", () => {
            // console.log("unregistered:", e);
            this.ua.stop();
            this.onChangeState(State.UNREGISTERED, {
              localAgent: this.localAgent,
            });
            this.sipSocket?.logout();
          });
          //注册失败
          this.ua.on("registrationFailed", (e) => {
            // console.error("registrationFailed", e)
            this.onChangeState(State.REGISTER_FAILED, {
              msg: "注册失败:" + e.cause,
            });
            this.sipSocket?.logout();
            this.ua.stop();
            this.socket = null;
          });
          //Fired a few seconds before the registration expires
          this.ua.on("registrationExpiring", () => {
            // console.log("registrationExpiring")
            this.ua.register();
          });

          //电话事件监听
          this.ua.on(
            "newRTCSession",
            (data: IncomingRTCSessionEvent | OutgoingRTCSessionEvent) => {
              // console.info('on new rtcsession: ', data)
              let s = data.session;
              let currentEvent: string;
              if (data.originator === "remote") {
                //来电处理
                //console.info('>>>>>>>>>>>>>>>>>>>>来电>>>>>>>>>>>>>>>>>>>>')
                this.incomingSession = data.session;
                this.currentSession = this.incomingSession;
                this.currentCallId = data.request.getHeader("x-session-id");
                this.direction = "inbound";
                currentEvent = State.INCOMING_CALL;
                this.playAudio();
              } else {
                //console.info('<<<<<<<<<<<<<<<<<<<<外呼<<<<<<<<<<<<<<<<<<<<')
                this.direction = "outbound";
                currentEvent = State.OUTGOING_CALL;
                this.playAudio();
              }

              s.on("peerconnection", (evt: PeerConnectionEvent) => {
                // console.info('onPeerconnection');
                //处理通话中媒体流
                this.handleAudio(evt.peerconnection);
              });

              s.on("connecting", () => {
                // console.info('connecting')
              });

              //防止检测时间过长
              let iceCandidateTimeout: NodeJS.Timeout;
              s.on("icecandidate", (evt: IceCandidateEvent) => {
                if (iceCandidateTimeout != null) {
                  clearTimeout(iceCandidateTimeout);
                }
                if (
                  evt.candidate.type === "srflx" ||
                  evt.candidate.type === "relay"
                ) {
                  evt.ready();
                }
                iceCandidateTimeout = setTimeout(evt.ready, 1000);
              });

              s.on("sending", () => {
                // console.info('sending')
              });

              s.on("progress", (evt: IncomingEvent | OutgoingEvent) => {
                // console.info('通话振铃-->通话振铃')
                //s.remote_identity.display_name
                if (
                  [180, 183].includes(
                    (evt as OutgoingEvent)?.response?.status_code
                  )
                ) {
                  this.sipSocket?.onDialing();
                }
                // 拨打电话后告知server状态变动
                this.onChangeState(currentEvent, {
                  direction: this.direction,
                  otherLegNumber:
                    data.originator === "remote"
                      ? data.request.from.uri.user
                      : data.request.to.uri.user,
                  callId: this.currentCallId,
                });
              });

              s.on("accepted", (evt: IncomingEvent | OutgoingEvent) => {
                // console.info('通话中-->通话中')
                this.stopAudio();
                this.onChangeState(State.IN_CALL, null);
              });
              s.on("accepted", () => {
                // console.info('accepted')
              });

              s.on("ended", (evt: any) => {
                // console.info('通话结束-->通话结束')
                let evtData: CallEndEvent = {
                  answered: true,
                  cause: evt.cause,
                  code: evt.message?.status_code ?? 0,
                  originator: evt.originator,
                };
                this.stopAudio();
                this.cleanCallingData();
                this.onChangeState(State.CALL_END, evtData);
              });

              s.on("failed", (evt: any) => {
                // console.info('通话失败-->通话失败')
                let evtData: CallEndEvent = {
                  answered: false,
                  cause: evt.cause,
                  code: evt.message?.status_code ?? 0,
                  originator: evt.originator,
                };
                this.stopAudio();
                this.cleanCallingData();
                this.onChangeState(State.CALL_END, evtData);
              });

              s.on("hold", (evt: HoldEvent) => {
                //console.info('通话保持-->通话保持')
                this.onChangeState(State.HOLD, null);
              });

              s.on("unhold", (evt: HoldEvent) => {
                //console.info('通话恢复-->通话恢复')
                this.stopAudio();
                this.onChangeState(State.UNHOLD, null);
              });
            }
          );

          this.ua.on(
            "newMessage",
            (data: IncomingMessageEvent | OutgoingMessageEvent) => {
              let s = data.message;
              s.on("succeeded", () => {
                // 修复: 不要使用ev.kick
                // console.log("newMessage-succeeded:", data, evt)
              });
              s.on("failed", () => {
                // 修复: 不要使用ev.kick
                // console.log("newMessage-succeeded:", data)
              });
            }
          );

          //启动UA
          this.ua.start();
        })
        .catch((e) => {
          throw new Error(e);
        });
    } else {
      throw new Error("username or password is required");
    }
  }

  //处理音频播放
  private handleAudio(pc: RTCPeerConnection) {
    this.audioView.autoplay = true;

    this.currentLatencyStatTimer = setInterval(() => {
      pc.getStats().then((stats) => {
        stats.forEach((report) => {
          if (report.type == "media-source") {
            this.currentStatReport.outboundAudioLevel = report.audioLevel;
          }
          if (
            report.type != "remote-inbound-rtp" &&
            report.type != "inbound-rtp" &&
            report.type != "remote-outbound-rtp" &&
            report.type != "outbound-rtp"
          ) {
            return;
          }
          switch (report.type) {
            case "outbound-rtp": //客户端发送的-上行
              this.currentStatReport.outboundPacketsSent = report.packetsSent;
              break;
            case "remote-inbound-rtp": //服务器收到的-对于客户端来说也就是上行
              this.currentStatReport.outboundLost = report.packetsLost;
              //延时(只会在这里有这个)
              this.currentStatReport.roundTripTime = report.roundTripTime;
              break;
            case "inbound-rtp": //客户端收到的-下行
              this.currentStatReport.inboundLost = report.packetsLost;
              this.currentStatReport.inboundAudioLevel = report.audioLevel;
              break;
            case "remote-outbound-rtp": //服务器发送的-对于客户端来说就是下行
              this.currentStatReport.inboundPacketsSent = report.packetsSent;
              break;
          }
        });
        let ls: LatencyStat = {
          latencyTime: 0,
          upLossRate: 0,
          downLossRate: 0,
          downAudioLevel: 0,
          upAudioLevel: 0,
        };

        if (this.currentStatReport.inboundAudioLevel != undefined) {
          ls.downAudioLevel = this.currentStatReport.inboundAudioLevel;
        }
        if (this.currentStatReport.outboundAudioLevel != undefined) {
          ls.upAudioLevel = this.currentStatReport.outboundAudioLevel;
        }

        if (
          this.currentStatReport.inboundLost &&
          this.currentStatReport.inboundPacketsSent
        ) {
          ls.downLossRate =
            this.currentStatReport.inboundLost /
            this.currentStatReport.inboundPacketsSent;
        }
        if (
          this.currentStatReport.outboundLost &&
          this.currentStatReport.outboundPacketsSent
        ) {
          ls.upLossRate =
            this.currentStatReport.outboundLost /
            this.currentStatReport.outboundPacketsSent;
        }
        if (this.currentStatReport.roundTripTime != undefined) {
          ls.latencyTime = Math.floor(
            this.currentStatReport.roundTripTime * 1000
          );
        }
        console.debug(
          "上行/下行(丢包率):" +
            (ls.upLossRate * 100).toFixed(2) +
            "% / " +
            (ls.downLossRate * 100).toFixed(2) +
            "%",
          "延迟:" + ls.latencyTime.toFixed(2) + "ms"
        );
        if (ls.downAudioLevel > 0) {
          this.stopAudio();
        }
        this.onChangeState(State.LATENCY_STAT, ls);
      });
    }, 1000);

    if ("addTrack" in pc) {
      pc.ontrack = (media) => {
        if (media.streams.length > 0 && media.streams[0].active) {
          this.audioView.srcObject = media.streams[0];
        }
      };
    } else {
      //onaddstream方法被规范不建议使用
      //@ts-ignore
      pc.onaddstream = (media: { stream: any }) => {
        let remoteStream = media.stream;
        if (remoteStream.active) {
          this.audioView.srcObject = remoteStream;
        }
      };
    }
  }

  //清理一通通话的相关数据
  private cleanCallingData() {
    this.outgoingSession = undefined;
    this.incomingSession = undefined;
    this.currentSession = undefined;
    this.direction = undefined;
    this.otherLegNumber = "";
    this.currentCallId = "";

    clearInterval(this.currentLatencyStatTimer);
    this.currentLatencyStatTimer = undefined;
    this.currentStatReport = {
      outboundPacketsSent: 0,
      outboundLost: 0,
      inboundLost: 0,
      inboundPacketsSent: 0,
      roundTripTime: 0,
      inboundAudioLevel: 0,
      outboundAudioLevel: 0,
    };
  }

  private onChangeState(
    event: string,
    data: StateListenerMessage | CallEndEvent | LatencyStat | null
  ) {
    if (event !== State.LATENCY_STAT) {
      sensors.track("sip_call_event", {
        extNo: this.localAgent,
        callId: this.currentCallId ?? "",
        eventName: event,
        content: JSON.stringify(data),
      });
    }
    if (undefined === this.stateEventListener) {
      return;
    }
    this.stateEventListener(event, data);
  }

  //check当前通话是否存在
  private checkCurrentCallIsActive(): boolean {
    if (!this.currentSession || !this.currentSession.isEstablished()) {
      this.onChangeState(State.ERROR, {
        msg: "当前通话不存在或已销毁，无法执行该操作。",
      });
      return false;
    }
    return true;
  }

  //注册请求
  public register() {
    sensors.track("sip_call_register", {
      extNo: this.localAgent,
      from: "sdk",
    });
    if (this.ua.isConnected()) {
      this.ua.register();
    } else {
      this.onChangeState(State.ERROR, {
        msg: "websocket尚未连接，请先连接ws服务器.",
      });
    }
  }

  //取消注册
  public unregister() {
    sensors.track("sip_call_unregister", {
      extNo: this.localAgent,
      from: "sdk",
    });
    if (this.ua && this.ua.isConnected() && this.ua.isRegistered()) {
      this.sipSocket?.logout();
      this.ua.unregister({ all: true });
      this.cleanSDK();
    } else {
      this.onChangeState(State.ERROR, { msg: "尚未注册，操作禁止." });
    }
  }

  //清理sdk初始化内容
  private cleanSDK() {
    //清理sdk
    this.stopAudio();
    this.cleanCallingData();
    if (this.ua) {
      try {
        if (this.ua.isRegistered()) {
          this.ua.unregister({ all: true });
        }
        this.ua.stop();
      } catch (e) {
        console.error("清理UA时出错:", e);
      }
    }

    if (this.socket) {
      this.socket = null;
    }

    // 清理SipSocket相关资源
    if (this.sipSocket) {
      try {
        // 确保WebSocket连接关闭
        if (
          this.sipSocket.client &&
          this.sipSocket.client.readyState === WebSocket.OPEN
        ) {
          this.sipSocket.logout();
        }
      } catch (e) {
        console.error("清理SipSocket时出错:", e);
      }
    }
  }

  public sendMessage = (target: string, content: string) => {
    sensors.track("sip_call_send_message", {
      extNo: this.localAgent,
      target: target,
      from: "sdk",
    });
    let options = {
      contentType: "text/plain",
    };
    this.ua.sendMessage(target, content, options);
  };

  public getCallOptionPcConfig(): RTCConfiguration | any {
    if (this.stunConfig && this.stunConfig.type && this.stunConfig.host) {
      if ("turn" === this.stunConfig.type) {
        return {
          iceTransportPolicy: "all",
          iceServers: [
            {
              username: this.stunConfig.username,
              credentialType: "password",
              credential: this.stunConfig.password,
              urls: [this.stunConfig.type + ":" + this.stunConfig.host],
            },
          ],
        };
      } else {
        return {
          iceTransportPolicy: "all",
          iceServers: [
            {
              urls: [this.stunConfig.type + ":" + this.stunConfig.host],
            },
          ],
        };
      }
    } else {
      return undefined;
    }
  }

  public checkAgentStatus(): boolean {
    if (!this.sipSocket) {
      return false;
    }
    return [2, 6, 7].includes(this.sipSocket.agentStatus);
  }

  private checkPhoneNumber(phone: string): boolean {
    return /^\d+$/.test(phone) && phone.length <= 15;
  }

  //发起呼叫
  public call = (phone: string, param: CallExtraParam = {}): string => {
    this.currentCallId = uuidv7().replace(/-/g, "");
    if (!this.checkPhoneNumber(phone)) {
      sensors.track("sip_call_call", {
        extNo: this.localAgent,
        phone: phone,
        businessId: param.businessId,
        outNumber: param.outNumber,
        callId: this.currentCallId,
        result: "error",
        content: "phone number format error",
        from: "sdk",
      });
      throw new Error("手机号格式不正确，请检查手机号格式。");
    }
    this.micCheck();
    if (!this.checkAgentStatus()) {
      let content = "";
      if (!this.sipSocket) {
        content = "websocket not connected";
      } else {
        content = "seat status abnormal value:" + this.sipSocket.agentStatus;
      }

      sensors.track("sip_call_call", {
        extNo: this.localAgent,
        phone: phone,
        businessId: param.businessId,
        outNumber: param.outNumber,
        callId: this.currentCallId,
        result: "error",
        content: content,
        from: "sdk",
      });
      throw new Error("坐席状态异常，请检查坐席状态。");
    }

    if (this.currentSession && !this.currentSession.isEnded()) {
      sensors.track("sip_call_call_error", {
        extNo: this.localAgent,
        phone: phone,
        businessId: param.businessId,
        outNumber: param.outNumber,
        callId: this.currentCallId,
        content: "call already exists",
        from: "sdk",
      });
      throw new Error("当前通话尚未结束，无法发起新的呼叫。");
    }
    //注册情况下发起呼叫
    if (this.ua && this.ua.isRegistered()) {
      const extraHeaders: string[] = ["X-JCallId: " + this.currentCallId];
      if (param) {
        if (param.businessId) {
          extraHeaders.push("X-JBusinessId: " + param.businessId);
        }
        if (param.outNumber) {
          extraHeaders.push("X-JOutNumber: " + param.outNumber);
        }

        extraHeaders.push("x-session-id: " + `CCMDL${this.currentCallId}`);
        extraHeaders.push("x-call_center_type: " + "OUTBOUND_CALL");
        extraHeaders.push("x-agent_channel: " + this.localAgent);
        extraHeaders.push("x-rtp-id: " + this.sipSocket?.rtpId);
      }
      this.outgoingSession = this.ua.call(phone, {
        eventHandlers: {
          //回铃音处理
          peerconnection: (e: { peerconnection: RTCPeerConnection }) => {
            this.handleAudio(e.peerconnection);
          },
        },
        mediaConstraints: this.constraints,
        extraHeaders: extraHeaders,
        sessionTimersExpires: 120,
        pcConfig: this.getCallOptionPcConfig(),
      });
      //设置当前通话的session
      this.currentSession = this.outgoingSession;
      this.otherLegNumber = phone;
      this.currentCallId = this.currentCallId;
      sensors.track("sip_call_call", {
        extNo: this.localAgent,
        phone: phone,
        businessId: param.businessId,
        outNumber: param.outNumber,
        callId: this.currentCallId,
        result: "success",
        content: "call success",
        from: "sdk",
      });
      return this.currentCallId;
    } else {
      sensors.track("sip_call_call", {
        extNo: this.localAgent,
        phone: phone,
        businessId: param.businessId,
        outNumber: param.outNumber,
        callId: this.currentCallId,
        result: "error",
        content: "not registered",
        from: "sdk",
      });
      this.onChangeState(State.ERROR, { msg: "请在注册成功后再发起外呼请求." });
      return "";
    }
  };

  //应答
  public answer() {
    sensors.track("sip_call_answer", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (this.currentSession && this.currentSession.isInProgress()) {
      this.currentSession.answer({
        mediaConstraints: this.constraints,
        pcConfig: this.getCallOptionPcConfig(),
      });
    } else {
      this.onChangeState(State.ERROR, {
        msg: "非法操作，通话尚未建立或状态不正确，请勿操作.",
      });
    }
  }

  //挂断电话
  public hangup() {
    sensors.track("sip_call_hangup", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (this.currentSession && !this.currentSession.isEnded()) {
      this.currentSession.terminate();
    } else {
      this.onChangeState(State.ERROR, {
        msg: "当前通话不存在，无法执行挂断操作。",
      });
    }
  }

  //保持通话
  public hold() {
    sensors.track("sip_call_hold", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.hold();
  }

  //取消保持
  public unhold() {
    sensors.track("sip_call_unhold", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    if (!this.currentSession.isOnHold()) {
      return;
    }
    this.currentSession.unhold();
  }

  //静音
  public mute() {
    sensors.track("sip_call_mute", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.mute();
    this.onChangeState(State.MUTE, null);
  }

  //取消静音
  public unmute() {
    sensors.track("sip_call_unmute", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.unmute();
    this.onChangeState(State.UNMUTE, null);
  }

  //转接
  public transfer(phone: string) {
    sensors.track("sip_call_transfer", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      transferTo: phone,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.refer(phone);
  }

  //发送按键
  public sendDtmf(tone: string) {
    sensors.track("sip_call_send_dtmf", {
      extNo: this.localAgent,
      otherLegNumber: this.otherLegNumber,
      tone: tone,
      direction: this.direction,
      callId: this.currentCallId,
      from: "sdk",
    });
    if (this.currentSession) {
      this.currentSession.sendDTMF(tone, {
        duration: 160,
        interToneGap: 1200,
        extraHeaders: [],
      });
    }
  }

  //麦克风检测
  public micCheck() {
    sensors.track("sip_call_mic_check", {
      extNo: this.localAgent,
      from: "sdk",
    });
    navigator.permissions
      .query({ name: "microphone" } as any)
      .then((result) => {
        if (result.state == "denied") {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风权限被禁用,请设置允许使用麦克风",
          });

          this.modal("Mic Permission Denied", "Please allow mic permission");
          return;
        } else if (result.state == "prompt") {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风权限未开启,请设置允许使用麦克风权限后重试",
          });
          this.modal(
            "Mic Permission Not Allowed",
            "Please allow mic permission"
          );
        }
        //经过了上面的检测，这一步应该不需要了
        if (navigator.mediaDevices == undefined) {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风检测异常,请检查麦克风权限是否开启,是否在HTTPS站点",
          });
          this.modal(
            "Mic Error Check Fail",
            "Please check the mic permission is open and is in https site"
          );

          return;
        }
        navigator.mediaDevices
          .getUserMedia({
            video: false,
            audio: true,
          })
          .then((_) => {
            _.getTracks().forEach((track) => {
              track.stop();
            });
          })
          .catch((_) => {
            this.modal(
              "Mic Error Check Fail",
              "Please check the mic is plugged in"
            );

            this.onChangeState(State.MIC_ERROR, {
              msg: "麦克风检测异常,请检查麦克风是否插好",
            });
          });
      });
  }

  //麦克风测试
  public static async testMicrophone(handle: (arg0: number) => void) {
    try {
      let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let context = new AudioContext(); //音频内容
      let recorder = context.createScriptProcessor(4096, 1, 1);
      recorder.addEventListener("audioprocess", (e) => {
        let buffer = e.inputBuffer.getChannelData(0);
        let maxVal = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (maxVal < buffer[i]) {
            maxVal = buffer[i];
          }
        }
        // 模拟音量
        handle(Math.round(maxVal * 100));
      });
      let audioInput = context.createMediaStreamSource(stream);
      audioInput.connect(recorder);
      recorder.connect(context.destination);
      const stop = () => {
        audioInput.disconnect();
        recorder.disconnect();
        stream.getTracks()[0].stop();
      };
      return {
        yes: () => {
          stop();
        },
        no: () => {
          stop();
        },
      };
    } catch (e) {
      return {
        yes: () => {},
        no: () => {},
      };
    }
  }

  //获取媒体设备
  public static async getMediaDeviceInfo() {
    if (navigator.mediaDevices == null) {
      return [];
    }
    return await navigator.mediaDevices.enumerateDevices();
  }

  // 设置为小休
  public setResting() {
    sensors.track("sip_call_set_resting", {
      extNo: this.localAgent,
      from: "sdk",
    });
    return this.sipSocket?.onResting();
  }

  // 设置为空闲
  public setIdle() {
    sensors.track("sip_call_set_idle", {
      extNo: this.localAgent,
      from: "sdk",
    });
    return this.sipSocket?.onIdle();
  }

  public transferCall(phone: string) {
    sensors.track("sip_call_transfer_call", {
      extNo: this.localAgent,
      transferTo: phone,
      from: "sdk",
    });
    return this.sipSocket?.transfer(phone);
  }

  // 设置为忙碌
  public setBusy() {
    sensors.track("sip_call_set_busy", {
      extNo: this.localAgent,
      from: "sdk",
    });
    return this.sipSocket?.onBusy();
  }

  public getOrgOnlineAgent() {
    sensors.track("sip_call_get_org_online_agent", {
      extNo: this.localAgent,
      from: "sdk",
    });
    return this.sipSocket?.getOrgOnlineAgent();
  }

  public wrapUp(seconds: number) {
    sensors.track("sip_call_wrap_up", {
      extNo: this.localAgent,
      seconds: seconds,
      from: "sdk",
    });
    return this.sipSocket?.wrapUp(seconds);
  }

  public wrapUpCancel() {
    sensors.track("sip_call_wrap_up_cancel", {
      extNo: this.localAgent,
      from: "sdk",
    });
    return this.sipSocket?.wrapUpCancel();
  }

  public playAudio() {
    sensors.track("sip_call_play_audio", {
      extNo: this.localAgent,
      from: "sdk",
    });
    let ringAudio = document.getElementById("ringMediaAudioId");
    if (!ringAudio) {
      ringAudio = document.createElement("audio");
      ringAudio.id = "ringMediaAudioId";
      ringAudio.hidden = true;
      (ringAudio as any).src = ring;
      (ringAudio as any).loop = "loop";
      document.body.appendChild(ringAudio);
    }
    (ringAudio as any).play();
  }

  public stopAudio() {
    sensors.track("sip_call_stop_audio", {
      extNo: this.localAgent,
      from: "sdk",
    });
    let ringAudio = document.getElementById("ringMediaAudioId");
    if (ringAudio) {
      document.body.removeChild(ringAudio);
    }
  }

  public refreshToken() {
    return this.sipSocket?.refreshToken();
  }

  public modal(title: string, content: string) {
    // Create compact modal in top-right corner
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    `;

    // Create compact modal content
    const modalContent = document.createElement("div");
    modalContent.style.cssText = `
      background: linear-gradient(145deg, #ffffff, #f8fafc);
      padding: 20px;
      border-radius: 12px;
      box-shadow: 
        0 10px 30px rgba(0, 0, 0, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.2);
      max-width: 320px;
      width: auto;
      min-width: 280px;
      transform: translateX(100%) scale(0.95);
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      position: relative;
      border: 1px solid rgba(255, 255, 255, 0.3);
      pointer-events: all;
    `;

    // Add compact icon
    const iconEl = document.createElement("div");
    iconEl.style.cssText = `
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 12px;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    `;
    iconEl.innerHTML = `
      <svg width="18" height="18" fill="none" stroke="white" viewBox="0 0 24 24" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
    `;

    // Add compact title
    const titleEl = document.createElement("h3");
    titleEl.textContent = title;
    titleEl.style.cssText = `
      margin: 0 0 8px 0;
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
      text-align: center;
      line-height: 1.3;
    `;

    // Add compact content
    const contentEl = document.createElement("p");
    contentEl.textContent = content;
    contentEl.style.cssText = `
      margin: 0 0 16px 0;
      font-size: 14px;
      line-height: 1.5;
      color: #6b7280;
      text-align: center;
      font-weight: 400;
    `;

    // Add close button (smaller)
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "确定";
    closeBtn.style.cssText = `
      background: linear-gradient(135deg, #3b82f6, #1d4ed8);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 8px 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
      display: block;
      margin: 0 auto;
      min-width: 80px;
    `;

    // Add close button (X) in top-right corner
    const closeXBtn = document.createElement("button");
    closeXBtn.innerHTML = "×";
    closeXBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      font-size: 20px;
      color: #9ca3af;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      transition: color 0.2s ease;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    `;

    // Add hover effects
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.transform = "translateY(-1px)";
      closeBtn.style.boxShadow = "0 4px 12px rgba(59, 130, 246, 0.4)";
    });

    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.transform = "translateY(0)";
      closeBtn.style.boxShadow = "0 2px 8px rgba(59, 130, 246, 0.3)";
    });

    closeXBtn.addEventListener("mouseenter", () => {
      closeXBtn.style.color = "#ef4444";
      closeXBtn.style.backgroundColor = "#fee2e2";
    });

    closeXBtn.addEventListener("mouseleave", () => {
      closeXBtn.style.color = "#9ca3af";
      closeXBtn.style.backgroundColor = "transparent";
    });

    // Close modal with animation
    const closeModal = () => {
      modalContent.style.transform = "translateX(100%) scale(0.95)";
      setTimeout(() => {
        if (document.body.contains(modal)) {
          document.body.removeChild(modal);
        }
      }, 300);
    };

    // Auto close after 5 seconds
    const autoCloseTimer = setTimeout(closeModal, 5000);

    closeBtn.addEventListener("click", () => {
      clearTimeout(autoCloseTimer);
      closeModal();
    });

    closeXBtn.addEventListener("click", () => {
      clearTimeout(autoCloseTimer);
      closeModal();
    });

    // Close on Escape key
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearTimeout(autoCloseTimer);
        closeModal();
        document.removeEventListener("keydown", handleKeydown);
      }
    };
    document.addEventListener("keydown", handleKeydown);

    // Assemble modal
    modalContent.appendChild(closeXBtn);
    modalContent.appendChild(iconEl);
    modalContent.appendChild(titleEl);
    modalContent.appendChild(contentEl);
    modalContent.appendChild(closeBtn);
    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    // Trigger entrance animation
    requestAnimationFrame(() => {
      modalContent.style.transform = "translateX(0) scale(1)";
    });
  }
}
