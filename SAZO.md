
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

# 이미지 업데이트 방법
## 1. Build

`docker build --platform=linux/amd64 -t n8n-sazo -f docker/images/n8n-sazo/Dockerfile .`
- amd64로 빌드해야합니다

## 2. Upload image
1. Tagging
`docker tag n8n-sazo:latest asia-northeast1-docker.pkg.dev/sazoshop/n8n-sazo/n8n-sazo:{버전명}`
> latest가 아니라 버전명을 사용해도 됩니다. 이 경우 아래 특정 버전으로 변경하는 방법을 참고하면 됩니다.

2. Upload 
`docker push asia-northeast1-docker.pkg.dev/sazoshop/n8n-sazo/n8n-sazo:{버전명}`

업로드가 되면 알아서 업데이트가 됩니다. 

## 3. image 버전을 특정 버전으로 변경 (필요시)
1. k8s/deployment.yaml 파일에서 template.spec.containers.image 를 수정
2. `kubectl apply -f k8s/deployment.yaml` 커맨드로 배포
3. `kubectl get pods -n n8n` 로 적용이 완료되었는 지 확인

# 기타 커맨드

## 클러스터 접속 
`gcloud container clusters get-credentials n8n-cluster-1 --region us-central1 --project sazoshop`

# 기타 정보 
## 이미지 저장소 (GCP Artifact Registory)

https://console.cloud.google.com/artifacts/docker/sazoshop/asia-northeast1/n8n-sazo/n8n-sazo?authuser=0&inv=1&invt=Abp8pA&project=sazoshop