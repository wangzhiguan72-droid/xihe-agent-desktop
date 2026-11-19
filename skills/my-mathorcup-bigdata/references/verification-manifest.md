# 羲和独立复算清单接口

只用于真实执行后登记。妈妈杯最终交付要求独立复算；未登记会阻塞，审稿或单问盲测按自身范围收尾。先用`verification_run({script:"independent/solve.py",inputs:["data/input.json"],result:"outputs/result.json"})`真实运行，脚本和明确输入复制到全新隔离目录，返回宿主`run_id`及脚本/结果路径与哈希。不得把主解结果列为盲算输入。回执证明所列文件及进程结果，不证明独立建模声明或科学机制正确。

随后用`independent_verify({manifest:"findings/independent.json"})`校验清单。下面`verification_runs/verify_ID/...`须替换成实际回执路径，不能自造`run_id`或`exit_code`。需要对拍表时用`result_compare`读取机器JSON，不手填相对误差；不同方案用`purpose=alternative`，不计复算通过数。

清单是 JSON 对象，以下 SHA-256 用实际文件内容计算，不填写占位值：

```json
{
  "schema_version": 2,
  "paper": {"rel":"paper/main.tex", "sha256":"实际64位哈希"},
  "source_result": {"rel":"outputs/main.json", "sha256":"实际64位哈希"},
  "files": [
    {"rel":"verification_runs/verify_ID/independent/solve.py", "sha256":"实际回执64位哈希", "kind":"script"},
    {"rel":"verification_runs/verify_ID/outputs/result.json", "sha256":"实际回执64位哈希", "kind":"result"}
  ],
  "provenance": {
    "independent_implementation":true,
    "target_answer_blind":true,
    "execution":{"run_id":"实际verification_run回执ID", "status":"succeeded", "exit_code":0, "script_rel":"verification_runs/verify_ID/independent/solve.py", "result_rel":"verification_runs/verify_ID/outputs/result.json"}
  },
  "metrics":[{
    "id":"coverage",
    "source":{"value":0.8,"result_key":"coverage","unit":"1","definition":"同一目标覆盖率","denominator":"固定验证集全部样本","time_origin":"同一起报时刻"},
    "replica":{"value":0.8,"result_key":"coverage","unit":"1","definition":"同一目标覆盖率","denominator":"固定验证集全部样本","time_origin":"同一起报时刻"},
    "tolerance":{"absolute":0.001},
    "classification":"match"
  }]
}
```

示例 0.8 仅演示结构，不是赛题结果。两份结果 JSON 的实际 `coverage` 必须分别等于登记数值；嵌套字段用点路径。登记后改数、仅刷新哈希而不更新指标、绑定无关论文均失败。论文已审计时必须对应当前 TeX 或 PDF 指纹。各输入、辅助程序也放 files 登记哈希，主解完整文件链沿用正式运行记录。

分类：相同定义/单位/分母/时间原点且满足事先容差为 `match`；真实不同口径为 `scope_difference`；同口径超容差为 `discrepancy`。后两类须有`resolution`：`status="resolved"`、具体处置的`reason`、当前`paper_sha256`，以及`disclosure:{rel,sha256,quote}`，绑定当前正文或章节内确实存在的披露文字。自由文字理由不能替代真实位置与当前指纹。未解决项保留为失败；零参考只能用绝对容差，`value_type="count"`计数严格相等。

复核意见用`review_finding`登记目标引文，修复后绑定实际修订引文和独立证据；数值问题另需真实运行回执。源稿、证据或回执变化后结项过期。审稿先`review_snapshot`，再读冻结副本，报告写`findings/reviews/`并`task_finish`；审稿完成不等于问题已全部修复。

回写论文会改变哈希：先完成分歧处置与论文编译，再为当前版本登记清单。改模型或科学结果须重算；仅导出变更只重验导出层，不重复科学计算。计算、复算、评审、编译、人工审核和提交状态分别记录。
