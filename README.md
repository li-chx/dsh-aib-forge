# DSH AIB Forge

DSH AIB Forge 是 [DeepSeek Harness AIB](https://github.com/li-chx/deepseek-harness-all-in-browser.git) 的可选插件构建后端。它编译 Host / Client 插件源码、准备 npm 包并提供构建产物，供浏览器安装和热替换。Forge 不托管用户的对话或 Harness 实例；未部署 Forge 时，前端仍可使用已打包的能力。

- 前端仓库：[deepseek-harness-all-in-browser](https://github.com/li-chx/deepseek-harness-all-in-browser.git)
- 后端仓库：[dsh-aib-forge](https://github.com/li-chx/dsh-aib-forge.git)

## 演示与 API Key

计划中的演示地址：[https://dsh-aiw.lichx.top](https://dsh-aiw.lichx.top)（待部署）。

演示不预置公共 API Key，需要自行填写临时 Key。默认直连模型 API 时，Key 保存在浏览器本地，仅随鉴权请求发送给所配置的模型提供商，不提交给演示站点服务器或 Forge 后端。自定义代理和第三方插件需要自行信任；请勿把 Key 写入提交给 Forge 编译的源码。**推荐体验结束后立即在模型提供商控制台撤销或删除临时 Key。**

## Docker 部署

在本仓库根目录执行：

```sh
cp .env.example .env
# 编辑 .env：FORGE_ORIGIN 为 EO 前端的实际访问源地址。
docker compose up -d --build
```

这里只构建和启动 Forge 后端，不拉取、构建或托管前端。前端独立部署到 EO，`FORGE_ORIGIN` 填写其实际访问源地址，例如 `https://dsh-aiw.lichx.top`。后端所需的版本清单及模块编译器已包含在 [runtime/](runtime/README.md) 中，需与所部署的前端匹配。

默认通过 `127.0.0.1:36936` 提供 HTTP 服务，由外部 Nginx 终结 HTTPS。构建产物保存在命名卷中。服务没有内置用户认证，公开部署需要可信入口的认证、资源限制和构建隔离。

完整配置、本地运行、协议与兼容性限制见[使用参考](docs/usage.md)及[设计说明](docs/design.md)。

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 li-chx。依赖及构建时引入的第三方代码遵循各自许可证。
