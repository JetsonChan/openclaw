import Testing
@testable import OpenClaw

struct BundledGatewayEnvironmentTests {
    @Test(arguments: [false, true])
    func `an older service stays visible beside the current app and seed`(seedMatchesBundle: Bool) {
        let status = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .incompatible(location: "/fixture/service", found: "2026.10.2", required: "2026.10.6"),
            expected: "2026.10.6",
            connectedVersion: nil,
            seedMatchesBundle: seedMatchesBundle,
            recoveryPending: true)

        #expect(status.gatewayVersion == "2026.10.2")
        #expect(status.kind == .incompatible(found: "2026.10.2", required: "2026.10.6"))
    }

    @Test func `a newly selected runtime does not replace the connected Gateway version`() {
        let status = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .ready(location: "/fixture/service", version: "2026.10.6"),
            expected: "2026.10.6",
            connectedVersion: "2026.10.2",
            seedMatchesBundle: true,
            recoveryPending: false)

        #expect(status.gatewayVersion == "2026.10.2")
        #expect(status.kind == .incompatible(found: "2026.10.2", required: "2026.10.6"))
    }

    @Test(arguments: [(false, false), (true, true)])
    func `unfinished preparation keeps repair available even when the Gateway version matches`(
        seedMatchesBundle: Bool, recoveryPending: Bool)
    {
        let status = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .ready(location: "/fixture/service", version: "2026.10.6"),
            expected: "2026.10.6",
            connectedVersion: "2026.10.6",
            seedMatchesBundle: seedMatchesBundle,
            recoveryPending: recoveryPending)

        #expect(status.gatewayVersion == "2026.10.6")
        guard case .error = status.kind else {
            Issue.record("Expected a repairable preparation failure, got \(status.kind)")
            return
        }
    }

    @Test func `bundled availability does not claim a missing Gateway is installed`() {
        let status = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .missing(location: "/fixture/service"),
            expected: "2026.10.6",
            connectedVersion: nil,
            seedMatchesBundle: false,
            recoveryPending: false)

        #expect(status.gatewayVersion == nil)
        #expect(status.kind == .missingGateway)
    }

    @Test(arguments: [("2026.10.6", true, false), ("2026.10.7", false, false), ("2026.10.7", false, true)])
    func `a compatible newer Gateway does not offer a downgrade to the app runtime`(
        version: String, seedMatchesBundle: Bool, recoveryPending: Bool)
    {
        let status = GatewayEnvironment.bundledEnvironmentStatus(
            installed: .ready(location: "/fixture/service", version: version),
            expected: "2026.10.6",
            connectedVersion: version,
            seedMatchesBundle: seedMatchesBundle,
            recoveryPending: recoveryPending)

        #expect(status.kind == .ok)
    }
}
