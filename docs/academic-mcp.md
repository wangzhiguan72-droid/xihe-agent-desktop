# academic-search MCP 调用边界

`core/academic_mcp.js` 是羲和运行时的只读学术元数据客户端。它通过 MCP stdio JSON-RPC 启动 `academic-search` 服务，完成 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`。协议依据：[MCP 官方 Python SDK 的 stdio 客户端说明](https://py.sdk.modelcontextprotocol.io/client/transports/)及 [TypeScript SDK 客户端说明](https://ts.sdk.modelcontextprotocol.io/client)。

服务来源按优先级选择：应用设置 `academic_mcp: {"command":"...","args":["..."]}`；其次本机若存在 Codex 配置 `~/.codex/config.toml` 中的 `[mcp_servers.academic-search]`；否则使用随包的 `vendor/academic-search-mcp/server.js`。模型只能请求 `search`、`paper`、`citation` 三种操作，分别固定对应 `search_papers`、`get_paper_by_id`、`get_citation`。检索只启用免费 CrossRef/arXiv 元数据源，单源最多 10 条；不调用 Scopus/ScienceDirect 额度。返回来源、DOI 和元数据须核查，检索条目不代表论文已精读。服务缺失、工具缺失、超时或协议错误均返回明确失败。

调用示例：`await callAcademic(settings, {operation:'search', query:'inverse problem', rows:5})`；按 DOI 取文献详情：`{operation:'paper', id:'10.1038/nature12373'}`。已在羲和工具层注册为 academic_search 模型工具（operation=status/search/paper/citation）；不要让模型传入启动命令、环境变量或任意 MCP 工具名。服务以 `shell:false` 启动，单次调用独立进程，45 秒超时、2 MiB 输出上限，子进程 stderr 不送入模型或接口。

验证：`node core/test_academic_mcp.js` 覆盖真实 stdio 握手、调用、超时与错误场景。随包的 academic-search 服务以 DOI `10.1038/nature12373` 成功返回匹配元数据，并完成 `network optimization` 关键词搜索。网络不可用时返回明确失败，不伪造结果。

`status` 返回 configured 与 connected:null，表示仅检查到可信本机配置，未进行连通测试。只有实际 search/paper/citation 返回成功才代表这次 MCP 调用完成。未返回的来源、全文或科学结论均不得声称已核实。
