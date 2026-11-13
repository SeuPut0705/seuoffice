//! The probe fakes of the `integrations` port's batch hosts

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(
    _hosts: &mut shell_contract::Hosts,
    _case: &serde_json::Value,
    _log: Option<super::Log>,
) {
}
