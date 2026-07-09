import { t } from '../i18n';

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
        <h3>{t('delete.title', { name })}</h3>
        <p>{t('delete.body')}</p>
        <div className="btns">
          <button className="pbtn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="del" onClick={onDelete}>
            {t('delete.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
