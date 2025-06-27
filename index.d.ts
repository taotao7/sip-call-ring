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
interface CallExtraParam {
    outNumber?: string;
    businessId?: string;
}
export default class SipCall {
    private constraints;
    private audioView;
    private ua;
    private socket;
    private localAgent;
    private outgoingSession;
    private incomingSession;
    private currentSession;
    private direction;
    private otherLegNumber;
    private currentCallId;
    private currentLatencyStatTimer;
    private currentStatReport;
    private stateEventListener;
    private stunConfig;
    private sipSocket;
    constructor(config: InitConfig);
    private handleAudio;
    private cleanCallingData;
    private onChangeState;
    private checkCurrentCallIsActive;
    register(): void;
    unregister(): void;
    private cleanSDK;
    sendMessage: (target: string, content: string) => void;
    getCallOptionPcConfig(): RTCConfiguration | any;
    checkAgentStatus(): boolean;
    private checkPhoneNumber;
    call: (phone: string, param?: CallExtraParam) => string;
    answer(): void;
    hangup(): void;
    hold(): void;
    unhold(): void;
    mute(): void;
    unmute(): void;
    transfer(phone: string): void;
    sendDtmf(tone: string): void;
    micCheck(): void;
    static testMicrophone(handle: (arg0: number) => void): Promise<{
        yes: () => void;
        no: () => void;
    }>;
    static getMediaDeviceInfo(): Promise<MediaDeviceInfo[]>;
    setResting(): Promise<any> | undefined;
    setIdle(): Promise<any> | undefined;
    transferCall(phone: string): Promise<any> | undefined;
    setBusy(): Promise<any> | undefined;
    getOrgOnlineAgent(): Promise<any> | undefined;
    wrapUp(seconds: number): Promise<any> | undefined;
    wrapUpCancel(): Promise<any> | undefined;
    playAudio(): void;
    stopAudio(): void;
    refreshToken(): Promise<void> | undefined;
    modal(title: string, content: string): void;
}
export {};
