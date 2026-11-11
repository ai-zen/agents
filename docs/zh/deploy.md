---
title: 部署与远程访问
description: 服务端只绑 loopback 而 wss:// 是客户端的能力、三种访问形态（本机 / 隧道 / 反向代理）各自的入口与要配的东西、nginx 反代完整样例与三个默认值陷阱（未转发 Upgrade 头就是握手 400、client_max_body_size 默认 1m 让 content.upload 撞 413、proxy_read_timeout 默认 60s 让空闲连接被掐）、AI_ZEN_ALLOWED_ORIGINS 必须填浏览器带来的那个来源、客户端地址与凭证的优先级（--server / AI_ZEN_SERVER_URL / 发现文件，AI_ZEN_SERVER_TOKEN / run/token）与「为什么没有 --token」、隧道下工作目录仍按本机递上去的已知行为、凭证能隔开谁和隔不开谁、排错对照表。
outline: deep
---

# 部署与远程访问

这一页回答「服务端跑在哪儿、客户端怎么连过去」。线上说什么在[线上协议](protocol.md) —— 那里只写允不允许；这里写实际怎么搭、哪几个默认值会把事情弄坏。

## 前提：服务端只绑 loopback

`agents-server serve` 只监听回环（缺省 `127.0.0.1:8790`），不是回环地址就拒绝启动。它**永不实现 TLS、永不绑非 loopback**：远程访问一律在它前面加一段（隧道或反向代理），明文那一段留在本机的回环上。

这条边界横在「同一台机器」上，不是「有没有鉴权」—— 凭证已经在了（见[线上协议](protocol.md)的「鉴权」），但把一个能力里有 `exec` 的服务直接摆到网络上的端口上，仍然不是这个项目要的默认状态。

| 事情 | 谁做 |
|---|---|
| 明文 WS（`ws://127.0.0.1:<port>`） | 服务端 |
| 隧道 / TLS 终结 | SSH、tailscale、nginx |
| 连 `ws://` 还是 `wss://` | **客户端**（`--server` / `AI_ZEN_SERVER_URL`） |

`wss://` 是客户端的一个能力，不是服务端的一个模式 —— 服务端那侧没有任何「开 TLS」的开关可配。

## 三种访问形态

| 形态 | 客户端连什么 | 服务端要配什么 | 客户端要配什么 |
|---|---|---|---|
| 本机（默认） | 发现文件里那个 `ws://127.0.0.1:<port>` | 什么都不用 | 什么都不用 |
| 隧道 | `ws://127.0.0.1:<隧道的本地端口>` | 什么都不用 | 显式地址 + `AI_ZEN_SERVER_TOKEN` |
| 反向代理 | `wss://your.domain[/path]` | `AI_ZEN_ALLOWED_ORIGINS`（浏览器来连的时候） | 显式地址 + `AI_ZEN_SERVER_TOKEN` |

三种形态的差别只在中间那一段；服务端与客户端说的话一个字都不变。

## 本机（默认）

什么都不用配。客户端按 `<aiZenDir>/run/server.json` 找到服务端（没有就拉起一个），凭证读同一个目录下的 `<aiZenDir>/run/token`。地址与凭证是同一个问题的两半（连哪儿 + 拿什么进门），所以放在同一个 `run/` 下：本机场景不需要任何人手动搬运任何一个。

## 隧道

入口仍是回环地址 —— 只是那个端口在另一端：

```bash
# 把远端那台机器的 127.0.0.1:8790 拉到本机的 9999
ssh -N -L 9999:127.0.0.1:8790 you@remote

export AI_ZEN_SERVER_TOKEN="$(ssh you@remote cat '~/.ai-zen/run/token')"
ai --server ws://127.0.0.1:9999
```

tailscale / `kubectl port-forward` 同理：它们做的事都是「在本机开一个回环端口，把它接到另一端的回环端口」。

**凭证必须显式给。** 「本机就有那个文件」在这里不成立 —— 本机的 `<aiZenDir>/run/token` 与远端那把锁毫无关系。客户端会先按本机文件试一遍，被拒时给出的提示正是这句话（见下文「客户端怎么连」）。

### 一个已知行为：工作目录仍按本机递上去

走 `ws://127.0.0.1:PORT` 的隧道时，客户端从地址上**看不出**对端不是本机 —— 入口恰恰是回环地址。于是它照本机场景的做法，把**本机的工作目录**当作工作区递上去；而远端那台机器上通常没有这个路径，服务端回 `workspace-path-missing`。

这是当前行为，不是 bug：客户端那边判「工作区归谁」只看地址的 host 是不是回环（`local-host.ts`），而从地址确实分不出「本机 daemon」与「隧道另一端」。

两条出路：在远端先建出这个路径；或者改用反向代理形态 —— `wss://your.domain/ai-zen` 不是回环地址，客户端就不会递本机目录，工作区由服务端的缺省值（`--workspace` 或它启动时所在目录）决定。

## 反向代理（nginx 终结 TLS）

前提是 nginx 与服务端在**同一台机器**上：nginx 对外 `wss://`，对内连 `ws://127.0.0.1:8790`（正好落在服务端那条 loopback 断言里）。

### nginx 配置

```nginx
# /etc/nginx/conf.d/ai-zen.conf
server {
    listen 443 ssl;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    # 子路径挂载：location 只匹配前缀、proxy_pass 不带 URI，于是上游收到的路径原样是 /ai-zen
    location /ai-zen {
        proxy_pass http://127.0.0.1:8790;

        # ① WebSocket 握手（三个陷阱见下面的「三个默认值陷阱」）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # ② 载荷上限：默认 1m，content.upload 超过就 413
        client_max_body_size 64m;

        # ③ 空闲上限：默认 60s，聊到一半会被掐
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

挂到根路径就把 `location /ai-zen` 换成 `location /`，客户端相应连 `wss://your.domain`。

### 三个默认值陷阱

| 指令 | 默认 | 不写的后果 | 写什么 | 为什么是这个值 |
|---|---|---|---|---|
| `proxy_http_version` + `Upgrade` / `Connection` | 对上游用 HTTP/1.0，且**不转发** `Upgrade` | 上游收到的是一次普通 HTTP 请求，不是升级请求 → 握手 **400**；而这条请求在日志里和别的一模一样，什么都看不出来 | `proxy_http_version 1.1` + 两个 `proxy_set_header` | WS 握手本身就是一次 `Upgrade` 请求；HTTP/1.0 没有这个语义，那两个头不转发就等于什么都没说 |
| `client_max_body_size` | **1m** | `content.upload` 的字节走二进制帧，超过上限时 nginx 直接回 **413**；客户端此刻正在等一条 WS 消息，它收到的是一条 HTTP 响应，读不懂，只表现为一条莫名其妙的连接错误 | **64m** | 与 WS 层「单条消息 64 MiB」的上限对齐（见[线上协议](protocol.md)的「大小上限」）。比它小，等于把协议允许的东西挡在门外；比它大，没有意义 |
| `proxy_read_timeout` | **60s** | 空闲超过 60 秒，nginx 主动掐掉上游那条 WS。用户看到的是「聊到一半突然断了」，而两端都没有报错 | **3600s** | 一轮对话里「模型在想」与「人去泡茶」都可能安静很久，而线上协议**没有**心跳要求（服务端不主动发请求，也不发 ping） |

三条都属于「配置是空的也会工作，只是工作得不对」那一类 —— 没有任何一条会在启动时报错。

### 配完之后

服务端那侧要把浏览器会带来的**来源**配进 `AI_ZEN_ALLOWED_ORIGINS`，否则自己的 webui 会被自己拒掉（403）：

```bash
AI_ZEN_ALLOWED_ORIGINS=https://your.domain agents-server serve
# systemd 里就是一行 Environment=AI_ZEN_ALLOWED_ORIGINS=https://your.domain
```

值是 `scheme://host[:port]`（多个用逗号分隔，逐项去空白，空项丢弃），判据与「无 `Origin` 放行」那几条见[线上协议](protocol.md)的「来源校验（Origin）」。不带 `Origin` 的客户端（CLI、桌面端、脚本）不受这一项影响。

## 客户端怎么连

| 什么 | 优先级（左高右低） |
|---|---|
| 地址 | `--server <url>` > `AI_ZEN_SERVER_URL` > `<aiZenDir>/run/server.json` |
| 凭证 | `AI_ZEN_SERVER_TOKEN` > `<aiZenDir>/run/token` > 无 |

```bash
# 凭证只走环境变量（下面这个写法是从远端那台机器上取）
export AI_ZEN_SERVER_TOKEN="$(ssh you@remote cat '~/.ai-zen/run/token')"
ai --server wss://your.domain/ai-zen
```

几条硬性质：

- **URL 接受 `ws:` / `wss:` / `http:` / `https:`**，后两个按 `http → ws`、`https → wss` 映射 —— 用户手上拿到的地址多半是 `https://your.domain`（浏览器地址栏里那一串）。**支持 path**（nginx 的子路径挂载），`wss://your.domain/ai-zen` 就是 URL 里的那个 `/ai-zen`。
- **没有 `--token`，这是有意的**：地址不是秘密，可以进 argv；凭证是秘密，进了 argv 就会留在 `ps` 的输出与 shell 历史里。所以凭证只有环境变量与文件两个来源。
- **给了显式地址就永不拉起本地服务端**：本地 `npx` 起的进程一定不在那个地址上，拉起只会白等一轮然后报一个指向错误方向的超时。
- **地址与凭证必须同源**：地址可以指向远端，凭证就不能只从本地文件读。「连得上、握手被拒」是半远程状态里最难查的一种，所以两者在客户端只有一个解析点，`unauthorized` 的提示也按「地址是谁给的 × 凭证从哪来」分成几句对症的话 —— 其中一句正是「这个地址上可能不是本机 daemon；若是 SSH 转发 / nginx / tailscale 隧道，请设 `AI_ZEN_SERVER_TOKEN`」。

## 安全边界

凭证隔的是**别的用户 / 别的网络**：没有它，任何能连到这个端口（或能连到 nginx 上那个域名）的东西都能用 `exec`。

它**隔不了同一用户下的其它进程**：凭证文件权限是 0600，而同一个用户当然读得到自己的 0600 文件 —— 那个用户跑的任何脚本都能拿到这把钥匙。这不是漏洞，是边界画在哪儿的问题：单用户工具的边界就是「这个用户」，不是「这个进程」。

## 排错对照表

| 现象 | 多半是 |
|---|---|
| 浏览器一进门就 403 | `AI_ZEN_ALLOWED_ORIGINS` 里没有那个 `https://your.domain` |
| WS 握手 400，nginx 日志里看不出为什么 | 少了 `proxy_http_version 1.1` 与 `Upgrade` / `Connection` 两个头 |
| 大文件上传时突然断开、客户端只报一条连接错误 | `client_max_body_size` 还是默认 **1m**（超限回 413） |
| 空闲一分钟左右突然断开 | `proxy_read_timeout` 还是默认 **60s** |
| `unauthorized` | `AI_ZEN_SERVER_TOKEN` 与那台机器 `<aiZenDir>/run/token` 不一致；没设时客户端退回的是本机那一份 |
| `workspace-path-missing` | 隧道形态下客户端把本机工作目录递上去了（见「隧道」的已知行为） |
