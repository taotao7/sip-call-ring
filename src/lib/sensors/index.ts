import sensors from "./sensorsdata.es6";

sensors.init({
  server_url: "https://t.mobilebene.com/s",
  is_track_single_page: false, // 单页面配置，默认开启，若页面中有锚点设计，需要将该配置删除，否则触发锚点会多触发 $pageview 事件
  use_client_time: false,
  send_type: "beacon",
  heatmap: {
    //是否开启点击图，default 表示开启，自动采集 $WebClick 事件，可以设置 'not_collect' 表示关闭。
    clickmap: "not_collect",
    //是否开启触达图，not_collect 表示关闭，不会自动采集 $WebStay 事件，可以设置 'default' 表示开启。
    scroll_notice_map: "not_collect",
  },
});

const app_key = "0b50c41e3e709671882b8ac7bf25cda0";

sensors.registerPage({
  current_url: location.href,
  referrer: document.referrer,
  app_key: app_key,
});

export default sensors;
