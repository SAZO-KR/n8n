
# SAZO n8n Integration Info

## 주의 사항
- n8n 측의 LICENSE_EE.md 에 포함되지 않는 범위에서만 수정을 해야 함.
- 내부 비즈니스 목적 또는 비상업적/개인적 용도로만 사용 가능함.
- ".ee."가 포함된 파일 또는 디렉토리는 수정하지 말 것.

## 로컬 실행
- pnpm 설치
- node v20.15 이상 (nvm 사용 권장)
- <code>pnpm install</code>
- <code>pnpm build</code>
- <code>pnpm dev</code>
- http://localhost:5678/ 접속

## 변경점
- packages/@n8n/config
	- 인증 정보 자동 갱신 차단.

```js
// src/configs/license.config.ts
autoRenewalEnabled: boolean = false; // 기존 true에서 false로 변경.
```

- 라이센스 코드 변경. (기능 강제 활성화)

```js
// src/license.ts
const autoRenewOffset = 72 * 1000 * Time.hours.toSeconds; // 기존 설정(72시간)에 1000을 곱함.

...

isFeatureEnabled(feature: BooleanLicenseFeature) {
	// return this.manager?.hasFeatureEnabled(feature) ?? false;
	if (feature === LICENSE_FEATURES.SHOW_NON_PROD_BANNER) {
		return false; // 제품 아닌 배너 표시 기능은 비활성화
	}
	return true;
}
getTeamProjectLimit() {
	// return this.getFeatureValue(LICENSE_QUOTAS.TEAM_PROJECT_LIMIT) ?? 0;
	return 1000;
}
getPlanName(): string {
	// return this.getFeatureValue('planName') ?? 'Community';
	return 'registered community'; // Community 외 확인된 다른 PlanName으로 변경. 내부에서 Community와 else로만 구분함.
}
```

- packages/cli
	- 서비스 시작 지점 로그 변경. (소스 반영 확인용.)

```js
// src/commands/start.ts
this.logger.info('Initializing n8n process [SAZO]');
```
