export function DeleteModal({
  name,
  onCancel,
  onDelete,
}: {
  name: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal">
        <h3>{name} を削除しますか?</h3>
        <p>SKILL.md と関連ファイルをゴミ箱に移動します(あとで復元できます)。</p>
        <div className="btns">
          <button className="pbtn" onClick={onCancel}>
            キャンセル
          </button>
          <button className="del" onClick={onDelete}>
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}
