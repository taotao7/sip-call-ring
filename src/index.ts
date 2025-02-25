import * as jssip from "jssip";
import { v4 as uuidv4 } from "uuid";
import SipSocket from "./sip";
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
        this.unregister.bind(this),
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
            user_agent: "JsSIP 3.9.0",
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
                  otherLegNumber: data.request.from.uri.user,
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
                this.onChangeState(State.IN_CALL, null);
              });
            }
          );

          this.ua.on(
            "newMessage",
            (data: IncomingMessageEvent | OutgoingMessageEvent) => {
              let s = data.message;
              s.on("succeeded", (evt) => {
                // console.log("newMessage-succeeded:", data, evt)
              });
              s.on("failed", (evt) => {
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
    if (this.ua && this.ua.isConnected() && this.ua.isRegistered()) {
      this.sipSocket?.logout();
      this.ua.unregister({ all: true });
      this.socket = null;
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
      this.ua.stop();
    }

    if (this.socket) {
      this.socket = null;
    }
  }

  public sendMessage = (target: string, content: string) => {
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
  public call = (phone: string, param: CallExtraParam = {}): String => {
    if (!this.checkPhoneNumber(phone)) {
      throw new Error("手机号格式不正确，请检查手机号格式。");
    }
    this.micCheck();
    if (!this.checkAgentStatus()) {
      throw new Error("坐席状态异常，请检查坐席状态。");
    }

    if (this.currentSession && !this.currentSession.isEnded()) {
      throw new Error("当前通话尚未结束，无法发起新的呼叫。");
    }

    //注册情况下发起呼叫
    this.currentCallId = uuidv4();
    if (this.ua && this.ua.isRegistered()) {
      const extraHeaders: string[] = ["X-JCallId: " + this.currentCallId];
      if (param) {
        if (param.businessId) {
          extraHeaders.push("X-JBusinessId: " + param.businessId);
        }
        if (param.outNumber) {
          extraHeaders.push("X-JOutNumber: " + param.outNumber);
        }
        extraHeaders.push("x-call_center_type: " + "OUTBOUND_CALL");
        extraHeaders.push("x-agent_channel: " + this.localAgent);
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
      return this.currentCallId;
    } else {
      this.onChangeState(State.ERROR, { msg: "请在注册成功后再发起外呼请求." });
      return "";
    }
  };

  //应答
  public answer() {
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
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.hold();
  }

  //取消保持
  public unhold() {
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
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.mute();
    this.onChangeState(State.MUTE, null);
  }

  //取消静音
  public unmute() {
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.unmute();
    this.onChangeState(State.UNMUTE, null);
  }

  //转接
  public transfer(phone: string) {
    if (!this.currentSession || !this.checkCurrentCallIsActive()) {
      return;
    }
    this.currentSession.refer(phone);
  }

  //发送按键
  public sendDtmf(tone: string) {
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
    navigator.permissions
      .query({ name: "microphone" } as any)
      .then((result) => {
        if (result.state == "denied") {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风权限被禁用,请设置允许使用麦克风",
          });
          return;
        } else if (result.state == "prompt") {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风权限未开启,请设置允许使用麦克风权限后重试",
          });
        }
        //经过了上面的检测，这一步应该不需要了
        if (navigator.mediaDevices == undefined) {
          this.onChangeState(State.MIC_ERROR, {
            msg: "麦克风检测异常,请检查麦克风权限是否开启,是否在HTTPS站点",
          });
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
    return this.sipSocket?.onResting();
  }

  // 设置为空闲
  public setIdle() {
    return this.sipSocket?.onIdle();
  }

  public transferCall(phone: string) {
    return this.sipSocket?.transfer(phone);
  }

  // 设置为忙碌
  public setBusy() {
    return this.sipSocket?.onBusy();
  }

  public getOrgOnlineAgent() {
    return this.sipSocket?.getOrgOnlineAgent();
  }

  public wrapUp(seconds: number) {
    return this.sipSocket?.wrapUp(seconds);
  }

  public wrapUpCancel() {
    return this.sipSocket?.wrapUpCancel();
  }

  public playAudio() {
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
    let ringAudio = document.getElementById("ringMediaAudioId");
    if (ringAudio) {
      document.body.removeChild(ringAudio);
    }
  }
}
