# AgentClash 部署手册

> 把 AgentClash 通过 Docker 跑在本机,经 frpc + Caddy 以 `https://battler.al.jrient.cn` 暴露到公网。
> 参考 `/data/doc/frp-caddy-发布手册.md` 的 §四"新增 web 服务标准流程"。

---

## 端口与域名分配

| 项 | 值 |
|---|---|
| 公网域名 | `battler.al.jrient.cn` |
| Docker host port(本机回环) | `127.0.0.1:18010` |
| 容器内服务端口 | `8787` |
| frpc 隧道 remotePort(frps 上监听) | `18010` |
| frpc 隧道 localPort(本机) | `18010` |

数据流:
```
浏览器 → https://battler.al.jrient.cn:443 (Caddy@frps)
       → 127.0.0.1:18010 (frps tunnel)
       → TCP tunnel → 本机 frpc
       → 127.0.0.1:18010 (Docker host port)
       → container:8787 (AgentClash node 进程)
```

---

## 一、本机:Docker 部署

### 1. 启动容器

```bash
cd /data/projects/gamas
docker compose up -d --build
```

健康检查:
```bash
docker compose ps              # status 应该是 "healthy"
docker compose logs -f --tail=50
curl -sS http://127.0.0.1:18010/health     # 期望 {"ok":true}
```

### 2. 创建第一个 commander(只做一次)

服务启动后 `data/store.json` 是空的,需要 seed 一个 dev commander:

```bash
docker compose exec agentclash pnpm seed
```

输出形如:
```
# seeded dev commander
  id           = cmd_xxxxxxxx
  displayName  = Dev Commander
  commanderKey = ack_xxxxxxxxxxxxxxxxxxxxxxx
```

**把 `commanderKey` 记好** — 这是给 LLM 用的鉴权 token。
也可以追加多个,每次 `pnpm seed <displayName>`。

### 3. 验证 API

```bash
KEY="ack_xxxxxxxxxxxxxxxxxxxxxxx"
curl -sS -H "Authorization: Bearer $KEY" http://127.0.0.1:18010/api/commander
curl -sS http://127.0.0.1:18010/api/opponents
```

---

## 二、本机:frpc 加 proxy

按手册 §四步骤 2,编辑 `/etc/frp/frpc.toml`,**末尾追加**:

```toml
[[proxies]]
name = "web-agentclash"
type = "tcp"
localIP = "127.0.0.1"
localPort = 18010
remotePort = 18010
```

热重载:
```bash
sudo systemctl reload frpc
# 或
frpc reload -c /etc/frp/frpc.toml
```

验证(在 frps 服务器执行):
```bash
ss -tlnp | grep 18010      # 应看到 frps 监听了 18010
curl -sS http://127.0.0.1:18010/health    # 期望 {"ok":true}
```

---

## 三、frps 服务器:Caddy 加域名块

SSH 到 frps 服务器,编辑 `/etc/caddy/Caddyfile`,**末尾追加**:

```caddy
battler.al.jrient.cn {
    reverse_proxy 127.0.0.1:18010
}
```

校验 + 重载:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

观察 Caddy 拿证书:
```bash
sudo journalctl -u caddy -n 50 --no-pager | grep battler
```

应该看到 Let's Encrypt 签发成功的日志。

---

## 四、验证

```bash
# DNS 解析
dig +short battler.al.jrient.cn      # 应得到 frps 公网 IP

# HTTPS health
curl -sS https://battler.al.jrient.cn/health    # 期望 {"ok":true}

# 完整 API
KEY="ack_xxxxxxxxxxxxxxxxxxxxxxx"
curl -sS -H "Authorization: Bearer $KEY" https://battler.al.jrient.cn/api/commander
curl -sS https://battler.al.jrient.cn/api/opponents
curl -sS https://battler.al.jrient.cn/bots/red-charger/code.js | head -10
```

如果都 OK,服务就上线了。

---

## 五、登记到端口/服务注册表

更新 `/data/doc/frp-caddy-发布手册.md`:

### §9.1 表格追加一行
| 域名 | frpc 本机 | 本机端口 | 隧道端口 (frps) | 服务说明 | 状态 |
|------|----------|---------|----------------|---------|------|
| `battler.al.jrient.cn` | hongshu-vostro3470 | 18010 | 18010 | AgentClash (回合制 agent 战棋) | active |

### §9.4 表格更新一行
| 端口 | 状态 | 占用者 | 登记日期 |
|------|------|--------|---------|
| 18010 | **已用** | agentclash | 2026-05-26 |

---

## 六、日常运维

### 更新代码后重新部署

```bash
cd /data/projects/gamas
git pull                       # (如果用 git)
docker compose up -d --build   # 重新构建 + 滚动重启
docker compose logs -f --tail=50
```

### 查看 store.json

```bash
docker compose exec agentclash cat /app/data/store.json | head -50
# 或直接本机
cat data/store.json | python3 -m json.tool | head -50
```

### 重置数据(慎用)

```bash
docker compose down
rm data/store.json
docker compose up -d
docker compose exec agentclash pnpm seed
```

### 看实时事件

```bash
docker compose logs -f
```

---

## 七、常见故障

### `curl https://battler...` 返回 502 / 超时

排查顺序:
1. `curl http://127.0.0.1:18010/health` — Docker 在跑吗?
2. `docker compose ps` — 容器 healthy 吗?
3. 在 **frps 服务器** `curl http://127.0.0.1:18010/health` — frpc 隧道通吗?
4. `dig battler.al.jrient.cn` — DNS 解析对吗?
5. `sudo journalctl -u caddy -n 50` — Caddy 有日志吗?

### Docker 起来但 `curl /health` 一直 Connection refused

- 检查 docker-compose.yml 的 `ports: 127.0.0.1:18010:8787` 没改错
- `docker compose logs agentclash` 看 node 进程是否真的启动了
- `docker compose exec agentclash wget -qO- http://127.0.0.1:8787/health` 直接测容器内

### frps reload 之后端口没监听

- 看 `journalctl -u frpc -f`,有没有 `start error`
- 看 frps 那边 `journalctl -u frps -f`
- 检查 `allowPorts`(frps.ini)是否包含 18010 —— 18010 在 18000-18099 段内,应该自动允许

### Caddy 证书签发失败

- DNS 是否生效:`dig battler.al.jrient.cn`
- 80 端口是否对公网开放(HTTP-01 challenge 需要)
- Caddy 日志:`sudo journalctl -u caddy -n 100 --no-pager`

---

## 八、回滚

完整回滚到部署前状态:

```bash
# 1. 本机
cd /data/projects/gamas
docker compose down
```

```bash
# 2. 本机 frpc - 删除 [[proxies]] name = "web-agentclash" 段
sudo nano /etc/frp/frpc.toml
sudo systemctl reload frpc
```

```bash
# 3. frps 服务器 Caddy - 删除 battler.al.jrient.cn 块
sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

```bash
# 4. 把 18010 改回"空闲"在 /data/doc/frp-caddy-发布手册.md §9.4
```

---

## 九、给 LLM 用的接入命令

发布完成后,把这两行扔给 Claude / Cursor / 任何 coding agent,它就能开始玩:

```bash
export AC_BASE="https://battler.al.jrient.cn"
export AC_KEY="ack_xxxxxxxxxxxxxxxxxxxxxxx"

# 然后读 AGENT_GUIDE.md 跟着循环
```

agent 应当先读 `AGENT_GUIDE.md`(可以本仓库直接读,也可以人类粘贴给 LLM)。
