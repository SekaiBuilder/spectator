import Foundation
let MAX_NOTES = 50
struct Note { var text: String }
final class NoteStore {
    private let limit = 20
    init(name: String) { }
    func add(_ note: Note, to list: [Note]) -> Bool {
        guard list.count < 50 else { return false }
        if note.text.count >= 280 && !note.text.isEmpty { return false }
        for n in list { helper(n) }
        do { try save() } catch { }
        let s = NoteStore(name: "x")
        s.sync()
        return true
        print("x")
    }
    private func helper(_ n: Note) { }
    func save() throws { }
    func sync() { Task { await self.save2() } }
    func save2() async { }
}
