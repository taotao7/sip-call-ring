import { $Fetch } from "ofetch";
declare class SipSocket {
    apiServer: $Fetch;
    client: WebSocket;
    agentStatus: number;
    loginStatus: boolean;
    exitStatus: boolean;
    rtpId: string | undefined;
    loginInfo: {
        username: string;
        password: string;
    };
    auth: {
        token: string;
        refreshToken: string;
        expireAt: number;
    };
    private heartbeatTimer;
    constructor(protocol: boolean, host: string, port: string, username: string, password: string, kick: () => void, // 接受kick操作
    statusListener: (v: number) => void, // 接受状态
    callbackInfo: (v: any) => void, // 接受callback info
    groupCallNotify: (v: any) => void, // 接受groupCallNotify
    otherEvent: (v: any) => void);
    listen(kick: () => void, statusListener: (v: number) => void, callbackInfo: (v: any) => void, groupCallNotify: (v: any) => void, otherEvent: (v: any) => void): void;
    checkLogin(): Promise<any>;
    login(): void;
    heartBeat(): void;
    private clearHeartbeat;
    logout(): void;
    private getSipWebrtcAddr;
    onDialing(): Promise<any>;
    onResting(): Promise<any>;
    onIdle(): Promise<any>;
    onBusy(): Promise<any>;
    transfer(num: string): Promise<any>;
    wrapUp(seconds: number): Promise<any>;
    wrapUpCancel(): Promise<any>;
    getOrgOnlineAgent(): Promise<any>;
    refreshToken(): Promise<void>;
}
export default SipSocket;
