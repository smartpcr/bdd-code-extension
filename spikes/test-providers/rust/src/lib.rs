pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    #[test]
    fn unit_add() { assert_eq!(super::add(2, 2), 4); }
}
