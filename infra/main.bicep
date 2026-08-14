@description('Base name used to derive resource names.')
@minLength(3)
@maxLength(20)
param appName string = 'featherflag'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Deployment environment.')
@allowed([
  'dev'
  'staging'
  'prod'
])
param environment string = 'dev'

@description('Fully qualified container image, e.g. ghcr.io/owner/featherflag:sha-abc123.')
param containerImage string

@description('Container registry hostname. Left empty for public images.')
param registryServer string = 'ghcr.io'

@description('Registry username. Empty means the image is public and pulled anonymously.')
param registryUsername string = ''

@description('Registry password or token. Empty means the image is public.')
@secure()
param registryPassword string = ''

@description('Git SHA of the running build, surfaced by /healthz.')
param appRevision string = 'unknown'

@description('Owning engineer email, written to the owner tag.')
param ownerEmail string

@description('Chargeback code, e.g. CC-1042.')
param costCenter string

@minValue(0)
@maxValue(10)
@description('Minimum replicas. Zero allows scale-to-zero, at the cost of cold starts.')
param minReplicas int = 1

@minValue(1)
@maxValue(30)
param maxReplicas int = 5

var tags = {
  owner: ownerEmail
  env: environment
  'cost-center': costCenter
  application: appName
  'managed-by': 'bicep'
}

var resourceSuffix = '${appName}-${environment}'
var usePrivateRegistry = !empty(registryUsername)

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceSuffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: environment == 'prod' ? 90 : 30
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceSuffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${resourceSuffix}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        // Container Apps terminates TLS at the ingress; this redirects any
        // plaintext request rather than serving it.
        allowInsecure: false
      }
      secrets: usePrivateRegistry ? [
        {
          name: 'registry-password'
          value: registryPassword
        }
      ] : []
      registries: usePrivateRegistry ? [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'LOG_LEVEL'
              value: environment == 'prod' ? 'info' : 'debug'
            }
            {
              name: 'APP_REVISION'
              value: appRevision
            }
          ]
          probes: [
            {
              // Liveness asks "is this process wedged?", so it hits /healthz,
              // which reports nothing but the process itself. Pointing it at a
              // dependency check would restart healthy containers whenever a
              // downstream service had a bad minute.
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              // Readiness gates traffic, so it hits /readyz, which fails as
              // soon as shutdown begins and drains this replica cleanly.
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 8080
              }
              initialDelaySeconds: 2
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = containerApp.properties.configuration.ingress.fqdn
output url string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output principalId string = containerApp.identity.principalId
output logAnalyticsWorkspaceId string = logAnalytics.id
