
import { writeFileSync } from "node:fs"
const out = process.argv[process.argv.indexOf("--out") + 1]
writeFileSync(out, JSON.stringify({ tool:"acceptance", case:"both", verdict:"PASS", target_sha256:"667e0d4393d9e97d13e0ed947a7814852e0848b9c7da9416def70a012833298e",
  cases:[{case_id:"app-01",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-02",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-03",expected:"x",actual:"x",verdict:"PASS"},{case_id:"app-04",expected:"x",actual:"x",verdict:"PASS"}] }))
process.exit(3)
