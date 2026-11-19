羲和内置技能目录。

本目录存放随应用分发的技能包：
- my-cumcm-deepseek：国赛数学建模全流程
- my-mathorcup-bigdata：MathorCup 大数据赛流程
- contest-modeling-apmcm：APMCM 赛事流程

技能入口为 `<name>/SKILL.md`，可在应用内通过 skill_load 加载；本目录优先级最高。用户自己的技能可放在应用数据目录或宿主技能目录中，由运行时按实际配置发现。
