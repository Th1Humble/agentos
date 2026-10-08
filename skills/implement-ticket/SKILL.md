---
name: implement-ticket
description: 实现已确认的产品方案，并在交付前调用 Tester 和 Code Reviewer Sub Agent 完成独立验证。
---

# Implement Ticket

## 执行顺序

1. 读取任务中给出的已确认产品文档或本地 Spec 与 Tickets，只实现当前范围。
2. 先检查仓库约定、现有实现和相关测试，再做最小且完整的代码修改。
3. 运行与改动相关的类型检查、测试和构建，先解决基础验证失败。
4. 调用当前 CLI 中配置的 Tester Sub Agent，让它使用 `agent-browser` 验收真实页面。
5. Tester 失败时，根据复现步骤和证据修复代码，再重新运行基础验证与 Tester。
6. Tester 通过后，调用 Code Reviewer Sub Agent，让它使用 `code-review-expert` 独立审查当前改动。
7. Reviewer 提出阻塞问题时，修复后重新运行受影响的基础验证、Tester 和 Reviewer。
8. 全部通过后，向 Agent OS 返回实现摘要、验证命令、Tester 结论、Reviewer 结论和剩余风险。

## 边界

- Tester 与 Reviewer 只给出独立结论，不代替开发者修改代码。
- 不擅自扩展产品范围，不自动部署，不自动创建 Pull Request。
- 无法启动应用、缺少账号或外部依赖不可用时，停止内部循环并明确报告阻塞。
