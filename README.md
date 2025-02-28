## 前情提要

开发环境必须用localhost，不然浏览器权限不会给你mic权限
生产环境必须https部署前端，不然也无法获取mic权限，这是浏览器安全策略,当然开发环境可以通过给浏览器加前缀绕过，但是你无法给每个客户启动浏览器的时候加前缀所以为了良好体验和接入顺利，部署一定使用https，开发一定用localhost
安装
安装方式分两种
模块化工程化安装 当前最新版本

- npm install sip-call-ring --save
- yarn install sip-call-ring --save

## 初始化

## 检查麦克风权限

调用初始化方法 this.sipClient = new SipCall(config)，建议用户登录业务系统的时候就进行初始化，要求全局唯一，切记不能每次拨打电话的时候都初始化一次。
收到回调事件「REGISTERED」表示注册成功。错误处理：监听事件，收到「DISCONNECTED」、「REGISTER_FAILED」做出相应提示
//设置配置信息用于初始化

```js
const config = {
  host: "xxx.xxxx.xxx", // 服务地址 IP
  port: "xxx", // 服务所在端口
  proto: true, // 使用wss或者ws协议,true为使用wss
  extNo: "xxx", //分机账号
  extPwd: "xxxx", //分机密码
  autoRegister: true, // 初始化后是否自动注册
  checkMic: true, // 自动检测mic
  stateEventListener: (event, data) => {
    // 监听事件，详细有哪些事件下面会介绍
    switch (event) {
      case "ERROR":
        // 做点什么
        break;
      case "CONNECTED":
        // 做点什么
        break;
      default:
    }
  },
  statusListener: (status) => {}, // 坐席状态 1: 离线, 2: 在线, 3: 响铃中, 4: 通话中, 5: 呼叫中, 6: 小休中 7:忙碌中 8:整理中}
  callbackInfo: (info) => {}, // 号码额外信息
  groupCallNotify: (info) => {},
  // type 1: 状态通知, 2: 任务进度通知
  // type===1: status 1// 待开始 , 2 // 进行中, 3 // 已完成 ,4 // 暂停中, 5 // 休息中
  // type===2: completedCount(已拨打), totalCount(总号码数)
  otherEvent: (other) => {},
};
const sipClient = new SipCall(config); // 实例初始化
```

## 监听的事件

下面是stateEventListener能够监听的事件
暂时无法在飞书文档外展示此内容
举个🌰

```js
const stateEventListener = (event, data) => {
  switch (
    event // 监听事件
  ) {
    case "DISCONNECTED": // 如果断开链接
      alert("连接已经断开");
      break;
    case "REGISTERED": // 如果注册成功
      alert("服务已经注册");
      break;
    case "UNREGISTERED":
      alert("服务已经注销");
      break;
    case "MIC_ERROR":
      alert(data.msg); // 麦克风错误并且弹出响应信息
      break;
    case "INCOMING_CALL": //呼入
      // data.otherLegNumber 是呼入的号码
      alert(`${data.otherLegNumber} 有电话呼入`);
    case "OUTGOING_CALL": // 呼出
      alert(`正在拨打 ${data.otherLegNumber}`);
      break;
    case "IN_CALL":
      alert("通话中");
      break;
    case "CALL_END":
      alert("通话结束");
      break;
    case "HOLD":
      alert("保持中");
      break;
    case "MUTE":
      alert("静音");
      break;
    case "UNMUTE":
      alert("取消静音");
      break;
    case "CONNECTED":
      alert("已连接");
      break;
    case "REGISTER_FAILED":
      alert("注册失败");
      break;
    default:
  }
};
```

## 实例内置的方法

暂时无法在飞书文档外展示此内容
举个🌰

```js
// 注册
sipClient.micCheck(); // 检查麦克风
sipClient.register(); // 如果在初始化的时候 autoRegister 参数设置为true这一步可以不用调用
sipClient.call("12123123123"); // 呼叫
sipClient.hangup(); // 挂断
sipClient.unregister(); //取消注册
sipClient.cleanSDK();
```

## 小tips

判断是否正在通话可以通过回调事件配合状态管理器来达到目的
在IN_CALL事件来确定正在通话
通过CALL_END来判断电话挂断
活用事件回调能实现很多功能
