import { ProxyAgent, setGlobalDispatcher } from "undici";

export function setupProxyFromEnv(): void {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log(`[proxy] outbound fetch routed via ${proxy}`);
}
