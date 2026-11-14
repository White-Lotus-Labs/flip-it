use near_sdk::env;
use num_bigint::BigUint;

pub const GENESIS: u64 = 1_692_803_367;
pub const PERIOD: u64 = 3;
pub const CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const PUBLIC_KEY: &str = concat!(
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d",
    "1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
);
const G2_GENERATOR: &str = concat!(
    "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e",
    "024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8",
);
const FIELD_MODULUS: &[u8] = b"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";
const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

pub fn round_after(timestamp: u64) -> u64 {
    (timestamp - GENESIS) / PERIOD + 2
}

pub fn round_time(round: u64) -> u64 {
    GENESIS + (round - 1) * PERIOD
}

pub fn verify(round: u64, signature: &[u8; 48]) -> bool {
    // Quicknet signs SHA-256 of the big-endian round number.
    if signature[0] & 0xc0 != 0x80 {
        return false;
    }
    let point = env::bls12381_p1_decompress(signature);
    let generator = env::bls12381_p2_decompress(hex::decode(G2_GENERATOR).unwrap());
    let public_key = env::bls12381_p2_decompress(hex::decode(PUBLIC_KEY).unwrap());
    let fields = hash_to_field(&env::sha256(round.to_be_bytes()));
    let mapped = env::bls12381_map_fp_to_g1(fields);

    // NEP-488 map outputs are already cofactor-cleared. Negate both before summing.
    let mut signed_points = [1; 194];
    signed_points[1..97].copy_from_slice(&mapped[..96]);
    signed_points[98..].copy_from_slice(&mapped[96..]);
    let negative_hash = env::bls12381_p1_sum(signed_points);

    // e(signature, generator) * e(-hash_to_curve(round), public_key) == 1.
    env::bls12381_pairing_check([point, generator, negative_hash, public_key].concat())
}

fn hash_to_field(message: &[u8]) -> [u8; 96] {
    // RFC 9380 expand_message_xmd with SHA-256, two 64-byte field inputs.
    let mut dst_prime = DST.to_vec();
    dst_prime.push(DST.len() as u8);
    let b0 = env::sha256([&[0; 64][..], message, &[0, 128, 0], &dst_prime].concat());
    let mut previous = [0; 32];
    let mut uniform = [0; 128];
    for (index, block) in uniform.chunks_exact_mut(32).enumerate() {
        let mixed: Vec<_> = b0
            .iter()
            .zip(previous)
            .map(|(left, right)| left ^ right)
            .collect();
        block.copy_from_slice(&env::sha256(
            [&mixed[..], &[(index + 1) as u8], &dst_prime].concat(),
        ));
        previous.copy_from_slice(block);
    }

    let modulus = BigUint::parse_bytes(FIELD_MODULUS, 16).unwrap();
    let mut encoded = [0; 96];
    for (field, bytes) in encoded.chunks_exact_mut(48).zip(uniform.chunks_exact(64)) {
        let reduced = (BigUint::from_bytes_be(bytes) % &modulus).to_bytes_be();
        let offset = field.len() - reduced.len();
        field[offset..].copy_from_slice(&reduced);
    }
    encoded
}

pub fn result_bit(contract: &str, bet_id: u64, signature: &[u8; 48]) -> u8 {
    let randomness = env::sha256(signature);
    let input = [
        b"coin-toss:v1\0",
        contract.as_bytes(),
        &[0],
        &bet_id.to_be_bytes(),
        &randomness,
    ]
    .concat();
    env::sha256(input)[0] & 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_public_quicknet_round_and_rejects_wrong_round() {
        let signature: [u8; 48] = hex::decode(
            "898a7998602631a38324d381fb225128656a3796320d69f19b4259ab4c6c3f52aa44a4a410054c49c1713c8db5d03fd2",
        ).unwrap().try_into().unwrap();
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        assert!(verify(33_705_244, &signature));
        assert!(!verify(33_705_245, &signature));
        assert!(!verify(33_705_244, &[0; 48]));
    }
}
