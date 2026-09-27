# Lotto Devnet Execution Log

> 项目：Solana + Rust + Anchor Lottery  
> 网络：Solana Devnet  
> 目的：保存面试可展示的关键真实链上执行证据。  
> 说明：本文件只收集关键路径与可验证结果，不包含无关全量日志。

---

## 1. Environment

```text
RPC:
https://api.devnet.solana.com

Program ID:
6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm

Operator / Authority:
mV8B9brE2rWGfbRWUKhqBws2PzdQLztfFWqLLZ8Rnn3

ProgramData:
4FaszNJ3VRjuCUyEizAxB9wLCYvNmC4pLnZyFDt882W8

MagicBlock VRF Program:
Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz

MagicBlock Devnet Queue:
Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh
```

Devnet lifecycle durations：

```text
sale duration         = 3600s
registration duration = 3600s
claim duration        = 3600s
```

---

## 2. Program Deployment

### Transaction

```text
J3UP1D7uBzM6wyMhFor3FerxNJQhvYmiHmxK8XShhSjrLeAAuuN33Z7TBfYERyaFkkTQhm2hsjmRh374TYat18B
```

### Result

```text
Program executable: true

Program:
6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm

ProgramData:
4FaszNJ3VRjuCUyEizAxB9wLCYvNmC4pLnZyFDt882W8

Upgrade authority:
operator wallet
```

### Evidence value

证明 Lotto Program binary 已真实部署到 Solana Devnet，而不是只在 Localnet / Surfpool 中运行。

---

## 3. Initialize Config

### Transaction

```text
2MNKDkRAA2mXCm3a66uVmtJC3YyPFwbaCmVwdboqDAQDdyUjL3U9Djg7sryARH6KfxaMWoxMcbZpgQJyKd5fagsx
```

### Accounts

```text
Config PDA:
CU931Wb7UTg6TYRfakeeuXWFQqVNMzyRyqfAQNRdFBQ5

Rollover Vault:
ib1JaaqMZK5VECVDTzc6tMnGQxESYzUfwJnzsmMq1DA
```

Rollover Vault：

```text
Owner: System Program
Data length: 0
Initial lamports: 650,240
```

### Config Parameters

```text
Ticket price:
10,000,000 lamports = 0.01 SOL

Tier thresholds:
[1, 2, 3]

Tier pool BPS:
[3334, 3333, 3333]
```

---

## 4. Create Round 0

### Transaction

```text
3gSDgEQBrN39R5ZAitv4CX4qrvNKqvophjF3XTsRvj9uRipDasDREgM75XcY86s4aUCwTR6Xm3s9T7HvARyv6kBS
```

### Accounts

```text
Round PDA:
j8fXgS1jUdhSiTNvRKzmBMp8NYj2mf8ifaDTPXYXW5Y

Prize Vault:
EfcT8xUhdi23qft6vNGtqea2UDm8LHkeiLuq2d3eotj9
```

### State

```text
Round ID: 0
Status: Selling

Config.nextRoundId:
0 -> 1

Config.activeRoundId:
None -> 0

Sale deadline:
1790482989
```

Prize Vault initial state：

```text
Owner: System Program
Data length: 0
Lamports: 650,240
```

---

## 5. Buy Ticket V2 — New Ticket Path

### Transaction

```text
5K5hsx3MMDGtvHmTUF1XzGiScXAtYwntJ8rQrsteLqWxPWLKiWQSZsN3YJjzc6izESBEDh4dVKEWVPywyk367gdb
```

### Ticket

```text
Ticket PDA:
5udZJZBZeLnLazCPJKpKsEA84dPUkqQRbmhvZ55RB3Vt

Quantity:
3

Outcome:
Unregistered
```

### Payment

```text
Business payment:
30,000,000

Ticket rent top-up:
929,640

Previous System Transfer total:
30,929,640
```

### Accounting

```text
Round.salesProceeds:
0 -> 30,000,000

Prize Vault:
650,240 -> 30,650,240
```

### Evidence value

真实验证 `buy_ticket_v2` 的 New Ticket 路径：

```text
payment proof
-> Prize Vault
-> rent extracted from Vault
-> Ticket allocate
-> assign Lotto Program
-> serialize Ticket
```

业务收入与 Ticket rent 没有混入同一 accounting 字段：

```text
salesProceeds only += business payment
```

---

## 6. Buy Ticket V2 — Existing Ticket Path

### Transaction

```text
3vVRabJpZmSmNqH4wjxsmL3ZpvuzMBKWRV61CQJXLgJtd5bcSDMPPQsBdT7ByQCiJgqWBeDQmjuX7jRFkS35RWJV
```

### Result

```text
Existing Ticket:
true

Previous quantity:
3

New quantity:
5

Business payment:
20,000,000

Rent top-up:
0
```

### Accounting

```text
Round.salesProceeds:
30,000,000 -> 50,000,000

Prize Vault:
30,650,240 -> 50,650,240
```

### Important semantic

```text
quantity = 5
```

不代表 5 个独立随机身份。

实际语义：

```text
1 buyer
1 Ticket PDA
1 deterministic outcome
quantity = payout multiplier
```

---

## 7. Request Randomness

请求前 Round：

```text
Status:
Selling

randomnessReady:
false

randomnessRequestedAt:
0

randomnessReceivedAt:
0
```

sale deadline 已到达。

### Transaction

```text
5afZtJ2wMVVmdXncFWeCfhwt5oqM2rEbTUbuXKjfTu1Mhr3yPeoDJFp3KXSeWeVJ8DZrevvHmR2nkFXqjxD9o15u
```

### After request

```text
Status:
RandomnessPending

randomnessReady:
false

randomnessRequestedAt:
1790485174

randomnessReceivedAt:
0
```

Binding：

```text
0x5ac6714e65e4f8ceff10452b82f91de564e5efaba38eefcf574ad54207dfb1a1
```

Randomness 此时仍为全零：

```text
0x0000000000000000000000000000000000000000000000000000000000000000
```

### Evidence value

`request_randomness` 没有直接产生业务随机数，也没有直接进入 Registering：

```text
Selling
-> RandomnessPending / ready=false
```

---

## 8. Real MagicBlock Callback

这是本次 Devnet run 最关键的证据之一。

### Successful Provider Transaction

```text
4J6EEFePwQBitqxuWN4EokmdVmHWSBfkRvp9NYPNDZdHq9rRBNmNeJ1GprLaW3xyVrd2YLRQ1vA3SthQuoENK6aU
```

### Slot / Block Time

```text
Slot:
504665072

Block time:
2026-09-27T12:59:35+08:00
```

### Provider Fee Payer

```text
vrfkfM4uoisXZQPrFiS2brY4oMkU9EWjyvmvqaFd5AS
```

该 fee payer 不是 Lotto operator wallet。

### Program Execution Chain

```text
MagicBlock VRF Program
Vrf1RNU...

    ↓ CPI

Lotto Program
6pZAWE...

    ↓

Instruction: ReceiveRandomness
```

关键日志：

```text
Program Vrf1RNU... invoke [1]

Program 6pZAWE... invoke [2]

Program log: Instruction: ReceiveRandomness

Program 6pZAWE... success

Program Vrf1RNU... success
```

### Received Randomness

```text
0xb68dab94ef032f1590c9fe3f02888e8caec3f4219738d6ac0db1c33539b2ef31
```

### Round State

```text
randomnessRequestedAt:
1790485174

randomnessReceivedAt:
1790485175
```

约 1 秒 callback latency。

```text
Status:
RandomnessPending

randomnessReady:
true
```

### Evidence value

证明 callback 是独立 provider transaction：

```text
operator request
-> MagicBlock VRF
-> independent provider transaction
-> VRF Program
-> CPI into Lotto
-> ReceiveRandomness
```

不是 operator 手工调用 `receive_randomness`。

callback 只写入 canonical randomness，并没有推进业务生命周期。

---

## 9. MagicBlock Provider Follow-up Attempts

此部分适合作为 troubleshooting appendix，不建议作为面试主展示线。

至少观察到两笔后续 provider-side transaction：

```text
jjZRF3a7DJhUn8N2CBPNr2zchCkDTcPhkpSRWoga6kou4jt8wjt4jxaQj4Koe57bTc7NcTrcuY2QhSqQ8gfTEPi

vfjetdEVbxjpdJPQaMWZvybEdmosu3ZSncvv8ryVhB9zbcjS8vXurN6xWwaueoTDs6K7wvfEFi37ft5b6e9UTrg
```

两笔共同特征：

```text
VRF Program invoked

custom program error: 0x1

没有进入 Lotto Program

没有 Instruction: ReceiveRandomness
```

因此可以确认：

```text
failure boundary = VRF Program
not Lotto Program
```

没有验证当前已部署 VRF binary 的精确 error enum mapping，因此不把 `0x1` 强行映射到具体错误名。

---

## 10. Settle Randomness

执行前额外做过一次 unsigned Devnet simulation：

```text
Simulation error: null

Program log:
Instruction: SettleRandomness

Program success
```

simulation 前后 Round account bytes 不变，证明只是只读模拟，没有写链。

### Transaction

```text
2utcQTPMdTkamTQnJdBhGWQc95bihELcxvFB8Q9DGsUDUTTNhfa2vZdGfZKjPfWbzcVf6C4RKVdecQGxcgK7jeBW
```

### Before

```text
Status:
RandomnessPending

randomnessReady:
true

randomnessRequestedAt:
1790485174

randomnessReceivedAt:
1790485175
```

### After

```text
Status:
Registering

Registration duration:
3600

Registration deadline:
1790491398

Chain timestamp after:
1790487799

Registration window open:
true
```

### Evidence value

验证 request / callback / settle 三步拆分：

```text
request
-> pending / ready=false

callback
-> pending / ready=true

settle
-> Registering
```

registration deadline 从 settle 时刻开始，而不是 callback 到达时开始。

---

## 11. Register Winner — Real Non-Winner Path

### Transaction

```text
4H7ws4eHGGi5P6hRDHjDCS3GHqXQESEhXnVYvkt5qKAHn1kLip6mCUPnK77kdh7cvKotsxFuNPLex2jDjNWQxVMg
```

### Before

```text
Ticket PDA:
5udZJZBZeLnLazCPJKpKsEA84dPUkqQRbmhvZ55RB3Vt

Quantity:
5

Outcome:
Unregistered

registeredUnits:
[0, 0, 0]

Treasury:
10,799,597,381
```

### Result

```text
Registration result:
Non-winner

Ticket closed:
true

registeredUnits:
[0,0,0] -> [0,0,0]
```

### Treasury

```text
Before:
10,799,597,381

After:
10,800,522,021

Observed delta:
+924,640
```

Ticket rent：

```text
929,640
```

Transaction fee：

```text
5,000
```

因此：

```text
929,640 rent returned
- 5,000 transaction fee
= +924,640 net wallet delta
```

当前：

```text
user = treasury = fee payer
```

所以 wallet delta 不能直接当作 protocol business cash flow。

---

## 12. Finalize Registration

deadline 到达前状态：

```text
Status:
Registering

registrationDeadline:
1790491398

registeredUnits:
[0,0,0]

prizePerUnit:
[0,0,0]

Prize Vault:
50,650,240
```

deadline 到达后：

```text
Chain timestamp:
1790491597

Registration deadline reached:
true
```

### Transaction

```text
34DTPDjYcrPMGthk7cZxR2h4eJiBSa8XVNk6eTJe8RRdgmYwtqFFCNH4bEPEzfZD28N82ovRJeFU86iCuVH1eham
```

### After

```text
Status:
Claiming

registeredUnits:
[0,0,0]

prizePerUnit:
[0,0,0]

Claim duration:
3600

Claim deadline:
1790495240

Claim window open:
true
```

### Evidence value

真实验证 zero-winner branch：

```text
registered_units[t] == 0
-> prize_per_unit[t] = 0
```

没有除零，也没有为无人登记的 tier 创建虚假 payout。

---

## 13. Finalize Round

claim deadline 到达时：

```text
Status:
Claiming

Chain timestamp:
1790508565

Claim deadline:
1790495240

Claim deadline reached:
true
```

### Transaction

```text
5HHpwsvc1coLtEY6fthPDj6ivWGpqnqTPq4bDV4QLuPZCx1hoKd8PQ9LJy27kLoLM9QKErXVNh9WBnMPEuczjyHD
```

### Before — Round

```text
Exists:
true

Owner:
6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm

Lamports:
1,823,720

Data length:
231
```

### Before — Prize Vault

```text
Exists:
true

Owner:
System Program

Lamports:
50,650,240

Rent reserve:
650,240

Business lamports:
50,000,000
```

### Before — Rollover Vault

```text
Lamports:
650,240
```

### Before — Treasury

```text
10,800,517,021
```

---

## 14. Final State

### Config

```text
activeRoundId:
0 -> None
```

### Round PDA

```text
Before:
Exists = true

After:
Exists = false
```

### Prize Vault

```text
Before:
50,650,240

After:
account closed
```

### Rollover Vault

```text
Before:
650,240

After:
50,650,240

Delta:
+50,000,000
```

Exact match：

```text
Expected business delta:
50,000,000

Actual:
50,000,000
```

### Treasury

Gross close funds：

```text
Round rent:
1,823,720

Prize Vault rent:
650,240

Total:
2,473,960
```

Transaction fee：

```text
5,000
```

Expected net：

```text
2,473,960
-     5,000
-----------
2,468,960
```

Observed：

```text
2,468,960
```

完全一致。

---

## 15. Verified Final Cash Flow

```text
Players
  │
  │ 50,000,000 business payment
  ▼
Prize Vault
50,650,240
  │
  ├── 50,000,000 ─────────► Rollover Vault
  │
  └──    650,240 ─────────► Treasury
                              Prize Vault rent

Round PDA
1,823,720 ─────────────────► Treasury
                              Round rent
```

最终：

```text
Rollover Vault:
50,650,240

Config.activeRoundId:
None

Round:
closed

Prize Vault:
closed
```

---

## 16. Full Verified Lifecycle

```text
Deploy
  ↓
Initialize Config
  ↓
Create Round
  ↓
Selling
  ↓
Buy Ticket V2 / New
  ↓
Buy Ticket V2 / Existing
  ↓
request_randomness
  ↓
RandomnessPending / ready=false
  ↓
MagicBlock real callback
  ↓
RandomnessPending / ready=true
  ↓
settle_randomness
  ↓
Registering
  ↓
register_winner
  ↓
Non-winner / Ticket closed
  ↓
finalize_registration
  ↓
Claiming / zero winners
  ↓
finalize_round
  ↓
50m business SOL rollover
  ↓
Round closed
Prize Vault closed
activeRoundId=None
```

---

## 17. Recommended Interview Evidence

面试主展示不需要把所有交易都铺开，优先保留下面 6 个。

### A. Buy Ticket V2 — New

```text
5K5hsx3...
```

重点：

```text
business payment + rent
payment proof
PDA initialization
salesProceeds excludes rent
```

### B. Buy Ticket V2 — Existing

```text
3vVRabJ...
```

重点：

```text
same canonical Ticket PDA
quantity 3 -> 5
no second rent charge
```

### C. VRF Request

```text
5afZtJ2...
```

重点：

```text
Selling -> RandomnessPending
request binding
no randomness fabricated locally
```

### D. Real MagicBlock Callback

```text
4J6EEFe...
```

重点日志：

```text
VRF Program invoke
-> Lotto invoke
-> Instruction: ReceiveRandomness
-> Lotto success
-> VRF success
```

重点说明：

```text
provider independently submitted callback
operator did not inject randomness
```

### E. Non-winner Registration

```text
4H7ws4e...
```

重点：

```text
deterministic result
Ticket consumed
rent returned to canonical Treasury
```

### F. Finalize Round

```text
5HHpwsv...
```

重点：

```text
50m business SOL -> Rollover
vault rent -> Treasury
Round rent -> Treasury
Round closed
Prize Vault closed
activeRoundId -> None
```

---

## 18. Explicit Coverage Boundary

本次真实 Devnet Round 没有产生 Winner。

因此本轮没有真实 Devnet 执行：

```text
claim_prize
```

面试时不能说：

> Devnet 已完整验证 winner claim happy path。

准确表述应为：

> Devnet smoke run 覆盖了真实 MagicBlock request/callback、non-winner registration、zero-winner finalization 和 rollover。Winner claim positive path 由本地 deterministic integration test 覆盖；本轮 Devnet 的唯一 Ticket 实际开奖为 non-winner。

---

## 19. Short Interview Summary

本次 Devnet smoke run 真实验证了：

```text
Program deployment
Config initialization
Round creation
Buy Ticket V2 new/existing paths
MagicBlock VRF request
Independent provider callback
Authenticated randomness write
Randomness settlement
Deterministic non-winner registration
Ticket close + rent recovery
Zero-winner prize finalization
Claiming lifecycle
Final rollover
Round / Prize Vault closure
activeRoundId cleanup
```

核心设计证据：

```text
Ticket quantity is a multiplier, not independent draws

request / callback / settle are separated

Round = Ledger
Vault = Cash

business lamports and rent are accounted separately

temporary protocol accounts are closed deterministically

remaining business funds roll into the canonical Rollover Vault
```
